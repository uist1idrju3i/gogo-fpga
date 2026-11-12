#!/usr/bin/env python3
"""Compare SBY artifacts with explicit, recorded environment-only differences."""

from contextlib import closing
from datetime import datetime
import json
import math
from pathlib import Path, PurePosixPath
import re
import shlex
import sqlite3
import xml.etree.ElementTree as ET


def require(condition, message):
    if not condition:
        raise ValueError(message)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "duplicate JSON key")
            result[key] = value
        return result
    def invalid(value):
        raise ValueError(f"nonfinite JSON value: {value}")
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


class ArtifactAudit:
    def __init__(self, yosys_pin, native_commands=None):
        require(re.fullmatch(r"[a-f0-9]{40}", yosys_pin), "invalid Yosys pin")
        self.pin = yosys_pin
        self.native_commands = native_commands or {}
        for tool, command in self.native_commands.items():
            require(tool in ["yosys", "yosys-smtbmc", "yosys-witness"] and isinstance(command, str) and command, "invalid native command")
            parts = shlex.split(command)
            require(parts and all(PurePosixPath(part).is_absolute() for part in parts), "native executable paths")
        self.variations = []

    def variation(self, field, runtime, value):
        self.variations.append({"field": field, "runtime": runtime, "value": value})

    def generator(self, value, runtime):
        match = re.fullmatch(r"(Yosys [0-9.]+ \(git sha1 ([a-f0-9]+)), Release, (GNU|Clang) ([^\n]+)\)", value)
        require(match is not None and len(match[2]) >= 7 and self.pin.startswith(match[2]), "Yosys source provenance")
        require(match[3] == ("GNU" if runtime == "native" else "Clang"), "unexpected compiler provenance")
        self.variation("compiler", runtime, value)
        return match[1] + ")"

    def root_log(self, value, runtime):
        result = []
        for line in value.splitlines(keepends=True):
            line = re.sub(r"^SBY +[0-9]{1,2}:[0-9]{2}:[0-9]{2} ", "SBY TIME ", line)
            if "Elapsed clock time" in line or "Elapsed process time" in line:
                match = re.fullmatch(r"(SBY TIME \[result\] summary: )?(Elapsed (clock|process) time)(?: \[H:MM:SS \(secs\)\]: ([0-9]+):([0-9]{2}):([0-9]{2}) \(([0-9]+)\)| unavailable in the browser)\n", line)
                require(match is not None, "unknown SBY resource line")
                if match[4] is None:
                    require(runtime == "pyodide" and match[3] == "process", "unexpected unavailable resource")
                else:
                    hours, minutes, seconds, total = map(int, match.group(4, 5, 6, 7))
                    require(minutes < 60 and seconds < 60 and hours * 3600 + minutes * 60 + seconds == total, "invalid SBY duration")
                    require(runtime == "native" or match[3] != "process", "browser process time must be unavailable")
                self.variation("SBY resource", runtime, line.rstrip())
                line = (match[1] or "") + match[2] + " RESOURCE\n"
            elif "Copy '" in line:
                match = re.fullmatch(r"SBY TIME \[result\] Copy '([^']+)' to '([^']+)'\.\n", line)
                require(match is not None, "unknown SBY copy line")
                source, destination = map(PurePosixPath, match.group(1, 2))
                require(source.is_absolute() and source.name == "top.v" and destination == source.parent / "result/src/top.v", "SBY input copy paths")
                if runtime == "pyodide":
                    require(str(source) == "/work/top.v", "browser source path")
                self.variation("source path", runtime, match.group(1, 2))
                line = "SBY TIME [result] Copy SOURCE to DESTINATION.\n"
            elif ": starting process " in line:
                match = re.fullmatch(r'SBY TIME \[result\] ([a-z0-9_.]+): starting process "cd (result(?:/(?:src|model))?); (.+)"\n', line)
                require(match is not None, "unknown SBY process invocation")
                commands = self.native_commands if runtime == "native" else {name: name for name in ["yosys", "yosys-smtbmc", "yosys-witness"]}
                tools = [tool for tool, command in commands.items() if match[3].startswith(command + " ")]
                require(len(tools) == 1, "unrecorded SBY executable")
                tool = tools[0]
                arguments = match[3][len(commands[tool]):]
                self.variation("executable", runtime, commands[tool])
                line = f'SBY TIME [result] {match[1]}: starting process "cd {match[2]}; {tool}{arguments}"\n'
            result.append(re.sub(r"^(SBY TIME \[result\] engine_0(?:\.(?:basecase|induction))?: ##) +[0-9]+:[0-9]{2}:[0-9]{2} +", r"\1 TIME ", line))
        return "".join(result)

    def yosys_log(self, value, runtime):
        result = []
        footers = 0
        profiles = 0
        for line in value.splitlines(keepends=True):
            if line.lstrip().startswith("Yosys "):
                space = line[:len(line) - len(line.lstrip())]
                line = space + self.generator(line.strip(), runtime) + "\n"
            elif line.startswith("End of script."):
                match = re.fullmatch(r"(End of script\. Logfile hash: [a-f0-9]{10}), time: [0-9.]+s, user: [0-9.]+s, system: [0-9.]+s(?:, MEM: [0-9.]+ MB peak)?\n", line)
                require(match is not None, "unknown Yosys footer")
                for number in re.findall(r"[0-9.]+(?=s| MB)", line):
                    require(math.isfinite(float(number)) and float(number) >= 0, "invalid Yosys resource")
                self.variation("Yosys resource", runtime, line.rstrip())
                line = match[1] + " RESOURCE\n"
                footers += 1
            elif line.startswith("Time spent:"):
                require(re.fullmatch(r"Time spent: (?:[0-9]+% [0-9]+x [a-zA-Z0-9_]+ \([0-9]+ sec\), )+\.\.\.\n", line), "unknown Yosys profile")
                require(all(int(number) <= 100 for number in re.findall(r"([0-9]+)%", line)), "invalid Yosys percentage")
                self.variation("Yosys profile", runtime, line.rstrip())
                line = "Time spent: PROFILE\n"
                profiles += 1
            result.append(line)
        require(footers == profiles == 1, "missing or repeated Yosys footer")
        return "".join(result)

    def jny(self, raw, runtime):
        data = strict_json(raw)
        data["generator"] = self.generator(data["generator"], runtime)
        require(isinstance(data["modules"], list), "JNY module list")
        for module in data["modules"]:
            sorts = module["cell_sorts"]
            require(isinstance(sorts, list) and all(isinstance(item["type"], str) for item in sorts), "JNY cell sorts")
            require(len({item["type"] for item in sorts}) == len(sorts), "duplicate JNY cell sort")
            self.variation("JNY cell sort order", runtime, [item["type"] for item in sorts])
            sorts.sort(key=lambda item: item["type"])
        return data

    def junit(self, raw, runtime):
        require(b"<!" not in raw, "unsupported XML declaration")
        root = ET.fromstring(raw)
        require(root.tag == "testsuites" and len(root) == 1 and root[0].tag == "testsuite", "JUnit suite shape")
        suite = root[0]
        datetime.strptime(suite.attrib["timestamp"], "%Y-%m-%dT%H:%M:%S")
        require(suite.attrib["hostname"] and re.fullmatch(r"[0-9]+", suite.attrib["time"]), "JUnit host or duration")
        if runtime == "pyodide":
            require(suite.attrib["hostname"] == "emscripten", "browser JUnit host")
        for field in ["timestamp", "hostname", "time"]:
            self.variation("JUnit " + field, runtime, suite.attrib[field])
            suite.attrib[field] = "ENVIRONMENT"
        properties = suite.findall("properties/property")
        os_properties = [item for item in properties if item.get("name") == "os"]
        require(len(os_properties) == 1, "JUnit OS property")
        require(os_properties[0].attrib["value"] == ("Linux" if runtime == "native" else "Emscripten"), "JUnit runtime OS")
        self.variation("JUnit OS", runtime, os_properties[0].attrib["value"])
        os_properties[0].set("value", "ENVIRONMENT")
        for element in suite.findall("system-out"):
            element.text = self.root_log(element.text or "", runtime)
        def tree(element):
            content = element.text or ""
            tail = element.tail or ""
            return [element.tag, dict(element.attrib), content if content.strip() else "", tail if tail.strip() else "", [tree(child) for child in element]]
        return tree(root)

    def database(self, path, runtime):
        path = Path(path).resolve(strict=True)
        require(all(not Path(str(path) + suffix).exists() for suffix in ["-wal", "-shm"]), "unsettled database")
        with closing(sqlite3.connect(path.as_uri() + "?immutable=1", uri=True)) as connection:
            require(connection.execute("PRAGMA integrity_check").fetchall() == [("ok",)], "database integrity")
            require(not connection.execute("PRAGMA foreign_key_check").fetchall(), "database foreign key")
            schema = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
            require([row[1] for row in schema] == ["task", "task_property", "task_property_status", "task_status", "task_trace"], "database schema")
            tables = {}
            for _, table, _, _ in schema:
                columns = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
                names = [column[1] for column in columns]
                require("created" in names and "id" in names, "database identity or timestamp")
                index = names.index("created")
                values = connection.execute(f'SELECT * FROM "{table}" ORDER BY id').fetchall()
                require(all(type(row[index]) in [int, float] and math.isfinite(row[index]) and row[index] > 0 for row in values), "invalid database timestamp")
                self.variation("SQLite " + table + ".created", runtime, [row[index] for row in values])
                tables[table] = {"columns": columns, "rows": [row[:index] + row[index + 1:] for row in values]}
            return {"schema": schema, "tables": tables}
