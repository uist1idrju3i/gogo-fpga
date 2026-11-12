import copy
import csv
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("sby_audit", ROOT / "scripts/audit-formal-sby.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class SbyAuditTest(unittest.TestCase):
    def write(self, name, value):
        target = self.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)
        sha = AUDIT.digest(b"binary")
        self.commands = {"yosys": "/native/yosys", "yosys-smtbmc": "'/native/python' '/source/smtbmc.py'", "yosys-witness": "'/native/python' '/source/witness.py'"}
        native = {"worktree": "", "preliminary": True, "commit": "1" * 40, "runtime": "native", "nativeCommands": self.commands,
                  "python": "Python unit", "yosys": {"sha256": sha, "version": "Yosys unit"}, "sources": {},
                  "pins": "".join(f"160000 commit {'1' * 40}\tvendor/{name}\n" for name in ["click", "sby", "yosys"])}
        self.write("native-metadata.json", native)
        meta = {"format": 1, "preliminary": True, "worktree": "", "commit": "1" * 40, "node": "unit", "pyodidePackage": "unit",
                "nativeMetadataSha256": AUDIT.digest((self.out / "native-metadata.json").read_bytes()), "snapshots": {},
                "sources": {"pins": {name: "1" * 40 for name in ["click", "sby", "yosys"]}, "origins": {}, "patches": {}, "assets": [{"path": "source.py", "size": 4, "sha256": AUDIT.digest(b"pass")}]},
                "yosys": {"sha256": sha, "shareSha256": sha}, "probes": {}}
        self.write("assets/source.py", b"pass")
        self.write("assets/manifest.json", meta["sources"])
        for name in AUDIT.SNAPSHOTS:
            self.write("snapshots/" + name, b"snapshot")
            meta["snapshots"][name] = AUDIT.digest(b"snapshot")
        for name in ["yosys.wasm", "yosys-share.tar", "yosys-native"]:
            self.write("inputs/" + name, b"binary")
        self.rows = []
        for solver in ["yices2", "z3"]:
            build = {"status": "built", "worktree_status": "", "artifact": {"sha256": sha}, "source": {"version": "unit"}}
            for name in [solver, solver + "-native"]:
                self.write("build/" + name + ".json", build)
            meta["probes"][solver] = {"sha256": sha, "nativeSha256": sha,
                "metadataSha256": AUDIT.digest((self.out / f"build/{solver}.json").read_bytes()),
                "nativeMetadataSha256": AUDIT.digest((self.out / f"build/{solver}-native.json").read_bytes())}
            for name in [solver + ".wasm", solver + "-native"]:
                self.write("inputs/" + name, b"binary")
            for case, (mode, depth, status, kind, code) in AUDIT.CASES.items():
                label = solver + "-" + case
                names = AUDIT.artifact_names(case)
                children = []
                for index in range(5 if mode == "prove" else 4):
                    args = ["yosys", "-ql", "model.log", "model.ys"] if index < 3 else ["yosys-smtbmc", "-t", str(depth)] + (["-i"] if index == 4 else [])
                    fail = int(index >= 3 and (case in ["bmc-violation", "cover-unreached"] or (case == "prove-inconclusive" and index == 4)))
                    child = {"processId": f"root:tool:{index}", "args": args, "status": "exited", "exitCode": fail, "role": "tool", "expectedTermination": False, "integrityVerified": True}
                    if index >= 3:
                        child["children"] = [{"status": "exited", "exitCode": 0, "error": None, "integrityVerified": True, "sha256": sha,
                            "args": ["yices-smt2", "--incremental"] if solver == "yices2" else ["z3", "-smt2", "-in"], "elapsedMs": 1.5, "memoryBytes": 1024, "stdoutBytes": 4, "stderrBytes": 0}]
                    children.append(child)
                for runtime in ["native", "pyodide"]:
                    prefix = label + "/" + runtime + "/"
                    generator = "Yosys 0.70 (git sha1 111111111, Release, " + ("GNU /native/c++ 1" if runtime == "native" else "Clang /wasi/clang++ 1") + ")"
                    process_time = "Elapsed process time [H:MM:SS (secs)]: 0:00:00 (0)\n" if runtime == "native" else "Elapsed process time unavailable in the browser\n"
                    summary = "Elapsed clock time [H:MM:SS (secs)]: 0:00:01 (1)\n" + process_time
                    log = ""
                    for index, child in enumerate(children):
                        tool = child["args"][0]
                        command = self.commands[tool] if runtime == "native" else tool
                        log += f'SBY  1:00:00 [result] phase_{index}: starting process "cd result; {command} {" ".join(child["args"][1:])}"\n'
                    log += "".join("SBY  1:00:00 [result] summary: " + line + "\n" for line in summary.splitlines())
                    log += f"SBY  1:00:00 [result] DONE ({status}, rc={code})\n"
                    for name in names:
                        if name.endswith(".sqlite"):
                            continue
                        raw = b"artifact\n"
                        if name in ["job.sby", "result/config.sby"]:
                            raw = f"mode {mode}\ndepth {depth}\nsmtbmc {'yices' if solver == 'yices2' else solver}\n".encode()
                        elif name == "result/status":
                            raw = f"{status} {code} 1\n".encode()
                        elif name == "result/logfile.txt":
                            raw = log.encode()
                        elif name in ["result/PASS", "result/FAIL", "result/UNKNOWN"]:
                            raw = summary.encode()
                        elif name == "result/job.xml":
                            host, os_name = ("unit", "Linux") if runtime == "native" else ("emscripten", "Emscripten")
                            raw = f'<testsuites><testsuite timestamp="2026-11-02T01:00:00" hostname="{host}" time="1"><properties><property name="os" value="{os_name}"/><property name="status" value="{status}"/></properties></testsuite></testsuites>'.encode()
                        elif name == "result/model/design.json":
                            raw = json.dumps({"generator": generator, "modules": [{"cell_sorts": [{"type": "$dff", "cells": []}, {"type": "$check", "cells": []}]}]}).encode()
                        elif name.endswith((".il", ".smt2")):
                            raw = (("# Generated by " if name.endswith(".il") else "; SMT-LIBv2 description generated by ") + generator + "\nMODEL\n").encode()
                        elif name.startswith("result/model/") and name.endswith(".log"):
                            raw = (generator + "\nBODY\nEnd of script. Logfile hash: 1234567890, time: 0.01s, user: 0.01s, system: 0.00s\nTime spent: 90% 1x prep (0 sec), ...\n").encode()
                        elif name.startswith("result/engine_0/logfile"):
                            fail = case in ["bmc-violation", "cover-unreached"] or (case == "prove-inconclusive" and "induction" in name)
                            raw = ("##   0:00:00  Status: " + ("failed" if fail else "passed") + "\n").encode()
                        self.write(prefix + name, raw)
                    db_path = self.out / prefix / "result/status.sqlite"
                    with sqlite3.connect(db_path) as db:
                        db.execute("CREATE TABLE task (id INTEGER PRIMARY KEY, workdir TEXT, mode TEXT, created REAL)")
                        db.execute("INSERT INTO task VALUES (1, 'result', ?, 1.5)", [mode])
                        db.execute("CREATE TABLE task_status (id INTEGER PRIMARY KEY, status TEXT, created REAL)")
                        if status != "UNKNOWN":
                            db.execute("INSERT INTO task_status VALUES (1, ?, 1.5)", [status])
                        for table in ["task_property", "task_property_status"]:
                            db.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, created REAL)")
                        db.execute("CREATE TABLE task_trace (id INTEGER PRIMARY KEY, path TEXT, engine_case TEXT, created REAL)")
                        for index, name in enumerate(sorted(n for n in names if n.endswith((".vcd", ".yw")))):
                            db.execute("INSERT INTO task_trace VALUES (?, ?, ?, 1.5)", [index + 1, name.removeprefix("result/"), "induction" if case == "prove-inconclusive" else None])
                    self.write(label + ("/native/stdout.log" if runtime == "native" else "/stdout.log"), log.encode())
                    self.write(label + ("/native/stderr.log" if runtime == "native" else "/stderr.log"), b"")
                files = {name: {"bytes": len((self.out / label / "native" / name).read_bytes()), "sha256": AUDIT.digest((self.out / label / "native" / name).read_bytes())} for name in names | {"stdout.log", "stderr.log"}}
                self.write(label + "/native.json", {"solver": solver, "case": case, "mode": mode, "depth": depth, "expected": status, "status": status, "kind": kind, "exitCode": code, "signal": None, "error": None, "elapsedMs": 1.25, "solverSha256": sha, "files": files})
                self.write(label + "/transport.json", {"status": "exited", "exitCode": code, "integrityVerified": True, "jobId": "root", "elapsedMs": 2.5, "children": children})
                count = sum(bool(AUDIT.re.search(r"\.(?:v|sby|ys|il|smt2|vcd|yw|smtc)$", n) or AUDIT.re.fullmatch(r"result/engine_0/logfile.*\.txt", n)) for n in names)
                row = {"solver": solver, "case": case, "mode": mode, "depth": depth, "expected": status, "status": status, "kind": kind, "exitCode": code, "elapsedMs": 2.5, "artifactCount": len(names), "comparedCount": count,
                    "sqliteSha256": AUDIT.digest((self.out / label / "pyodide/result/status.sqlite").read_bytes()), "modelSha256": AUDIT.digest((self.out / label / "pyodide/result/model/design_smt2.smt2").read_bytes()), "solverSha256": sha, "yosysSha256": sha, "error": None}
                self.rows.append(row)
                self.write(label + "/result.json", row)
        self.write("metadata-final.json", meta)
        self.write("metadata.json", {**copy.deepcopy(meta), "probes": {}})
        self.write("results.json", {"preliminary": True, "rows": self.rows})
        self.csv_rows = [{key: AUDIT.cell(row[key]) for key in AUDIT.COLUMNS} for row in self.rows]
        self.save_csv()

    def save_csv(self):
        with (self.out / "results.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=AUDIT.COLUMNS)
            writer.writeheader()
            writer.writerows(self.csv_rows)

    def test_complete_matrix_and_all_artifacts(self):
        result = AUDIT.audit(self.out)
        self.assertEqual((result["status"], result["rows"], result["columns"], result["artifacts"]), ("pass", 12, 16, 268))
        self.assertTrue(all(AUDIT.re.fullmatch(r"[a-f0-9]{64}", row["canonicalSha256"]) for row in result["conditions"]))

    def test_formal_mode_requires_matching_native_metadata_and_runner(self):
        for name in ["metadata.json", "metadata-final.json", "results.json"]:
            data = json.loads((self.out / name).read_bytes())
            data["preliminary"] = False
            if name.startswith("metadata"):
                data["snapshots"]["scripts/measure-formal-sby.py"] = AUDIT.digest(b"runner")
            self.write(name, data)
        self.write("snapshots/scripts/measure-formal-sby.py", b"runner")
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)
        native = json.loads((self.out / "native-metadata.json").read_bytes())
        native["preliminary"] = False
        self.write("native-metadata.json", native)
        for name in ["metadata.json", "metadata-final.json"]:
            data = json.loads((self.out / name).read_bytes())
            data["nativeMetadataSha256"] = AUDIT.digest((self.out / "native-metadata.json").read_bytes())
            self.write(name, data)
        self.assertIs(AUDIT.audit(self.out)["preliminary"], False)

    def test_every_csv_column_rejects_corruption(self):
        for column in AUDIT.COLUMNS:
            with self.subTest(column=column):
                original = self.csv_rows[0][column]
                self.csv_rows[0][column] = "corrupt"
                self.save_csv()
                with self.assertRaises(ValueError):
                    AUDIT.audit(self.out)
                self.csv_rows[0][column] = original

    def test_every_artifact_rejects_modification_and_missing_files(self):
        for name in AUDIT.artifact_names("bmc-violation"):
            path = self.out / "yices2-bmc-violation/pyodide" / name
            original = path.read_bytes()
            with self.subTest(name=name):
                path.write_bytes(b"corrupt")
                with self.assertRaises((ValueError, KeyError, sqlite3.DatabaseError, AUDIT.ARTIFACTS.ET.ParseError)):
                    AUDIT.audit(self.out)
                path.unlink()
                with self.assertRaises((ValueError, OSError)):
                    AUDIT.audit(self.out)
                path.write_bytes(original)

    def test_unverified_crashed_cancelled_timed_out_or_nonzero_solvers_fail(self):
        path = self.out / "yices2-bmc-prefix/transport.json"
        original = path.read_bytes()
        for key, value in [("status", "crashed"), ("status", "cancelled"), ("status", "timeout"), ("integrityVerified", False), ("exitCode", 1)]:
            data = json.loads(original)
            data["children"][3]["children"][0][key] = value
            path.write_text(json.dumps(data))
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                AUDIT.audit(self.out)
        path.write_bytes(original)

    def test_inputs_and_native_inventory_are_verified(self):
        for name in ["inputs/yosys.wasm", "inputs/z3-native", "inputs/yices2.wasm", "yices2-bmc-prefix/native/top.v"]:
            path = self.out / name
            original = path.read_bytes()
            path.write_bytes(b"modified")
            with self.subTest(name=name), self.assertRaises(ValueError):
                AUDIT.audit(self.out)
            path.write_bytes(original)

    def test_duplicate_nonfinite_json_and_parent_symlinks_are_rejected(self):
        for raw in [b'{"status":"pass","status":"fail"}', b'{"elapsed":NaN}', b'{"elapsed":Infinity}']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                AUDIT.strict_json(raw)
        (self.out / "linked").symlink_to(self.out / "assets", target_is_directory=True)
        with self.assertRaises(ValueError):
            AUDIT.Evidence(self.out).read("linked/source.py")

    def test_semantically_valid_artifact_and_transport_mutations_fail(self):
        mutations = [
            ("pyodide/result/logfile.txt", lambda raw: raw.replace(b"DONE (PASS, rc=0)", b"DONE (FAIL, rc=2)")),
            ("pyodide/result/logfile.txt", lambda raw: raw.replace(b"; yosys ", b"; unknown-yosys ")),
            ("pyodide/result/logfile.txt", lambda raw: raw.replace(b"0:00:01 (1)", b"0:00:01 (9)")),
            ("pyodide/result/model/design.log", lambda raw: raw.replace(b"1234567890", b"123456789f")),
            ("pyodide/result/model/design.log", lambda raw: raw.replace(b"111111111", b"222222222")),
            ("pyodide/result/model/design.json", lambda raw: raw.replace(b"$dff", b"$invalid")),
            ("pyodide/result/job.xml", lambda raw: raw.replace(b'value="PASS"', b'value="FAIL"')),
            ("pyodide/result/job.xml", lambda raw: raw.replace(b'name="os"', b'name="not-os"')),
            ("pyodide/result/job.xml", lambda raw: raw.replace(b'time="1"', b'time="9"')),
            ("pyodide/result/status", lambda raw: raw.replace(b"PASS 0", b"FAIL 2")),
            ("transport.json", lambda raw: raw.replace(b'"expectedTermination": false', b'"expectedTermination": true')),
            ("transport.json", lambda raw: raw.replace(b'"exitCode": 0', b'"exitCode": false')),
            ("transport.json", lambda raw: raw.replace(b'"root:tool:0"', b'"foreign:tool:0"')),
        ]
        for name, mutate in mutations:
            path = self.out / "yices2-bmc-prefix" / name
            original = path.read_bytes()
            mutated = mutate(original)
            self.assertNotEqual(mutated, original)
            path.write_bytes(mutated)
            with self.subTest(name=name), self.assertRaises(ValueError):
                AUDIT.audit(self.out)
            path.write_bytes(original)

    def test_sqlite_content_schema_and_pending_wal_are_rejected(self):
        path = self.out / "yices2-bmc-prefix/pyodide/result/status.sqlite"
        original = path.read_bytes()
        for sql in ["UPDATE task_status SET status='FAIL'", "UPDATE task SET mode='prove'", "ALTER TABLE task ADD COLUMN unexpected TEXT", "DROP TABLE task_trace"]:
            with sqlite3.connect(path) as db:
                db.execute(sql)
            with self.subTest(sql=sql), self.assertRaises(ValueError):
                AUDIT.audit(self.out)
            path.write_bytes(original)
        wal = Path(str(path) + "-wal")
        wal.write_bytes(b"pending")
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)

    def test_only_recorded_environment_fields_are_normalized(self):
        evidence = AUDIT.Evidence(self.out)
        a = AUDIT.ARTIFACTS.ArtifactAudit("1" * 40, self.commands)
        p = "yices2-bmc-prefix/"
        native = evidence.read(p + "native/result/model/design.json")
        browser = json.loads(evidence.read(p + "pyodide/result/model/design.json"))
        browser["modules"][0]["cell_sorts"].reverse()
        self.assertEqual(a.jny(native, "native"), a.jny(json.dumps(browser), "pyodide"))
        db = evidence.path(p + "pyodide/result/status.sqlite")
        before = a.database(db, "pyodide")
        with sqlite3.connect(db) as connection:
            connection.execute("UPDATE task_status SET created=2.5")
        self.assertEqual(before, a.database(db, "pyodide"))
        self.assertIn({"field": "SQLite task_status.created", "runtime": "pyodide", "value": [2.5]}, a.variations)
        browser_log = evidence.read(p + "pyodide/result/model/design.log").decode()
        self.assertEqual(a.yosys_log(browser_log, "pyodide"), a.yosys_log(browser_log.replace("time: 0.01s", "time: 1.23s"), "pyodide"))
        with self.assertRaises(ValueError):
            a.generator("Yosys 0.70 (git sha1 111111111, Release, GNU wrong-runtime)", "pyodide")
