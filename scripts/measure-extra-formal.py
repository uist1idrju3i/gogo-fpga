#!/usr/bin/env python3
"""Measure and audit additional solvers across SMTBMC, SBY, and fault boundaries."""

import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SMT, SBY, CONTROLS = (load(name) for name in ["audit-formal-python", "audit-formal-sby", "audit-formal-controls"])
require, Evidence, digest = SBY.require, SBY.Evidence, SBY.digest
SOLVERS = ("bitwuzla", "boolector")
SNAPSHOTS = ["measure-extra-formal.py", "audit-formal-python.py", "audit-formal-sby.py", "audit-formal-controls.py", "sby-artifact-audit.py", "formal-solver-audit.py"]
SCHEDULE = [("aa", n) for n in [1, 2]] + [("run", n) for n in range(1, 6)]
COLUMNS = {"smtbmc": ["series", "iteration", *SMT.COLUMNS],
           "sby": ["series", "iteration", "nativeElapsedMs", *SBY.COLUMNS],
           "controls": ["series", "iteration", *CONTROLS.COLUMNS]}


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def write(path, value):
    with Path(path).open("x") as stream:
        stream.write(encoded(value) + "\n")


def csv_bytes(rows, columns):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=columns, lineterminator="\n", quoting=csv.QUOTE_ALL)
    writer.writeheader()
    writer.writerows({key: "" if row[key] is None else row[key] for key in columns} for row in rows)
    return stream.getvalue().encode()


def audit_pair(directory, solver, commit):
    evidence = Evidence(directory)
    reports = {"smtbmc": SMT.audit(evidence.path("smtbmc"), (solver,)),
               "sby": SBY.audit(evidence.path("sby"), (solver,)),
               "controls": CONTROLS.audit(evidence.path("controls"), (solver,))}
    for report in reports.values():
        require(report["preliminary"] is False and report["commit"] == commit, "same clean formal commit")
    return reports


def audit_campaign(directory, saved=True):
    evidence = Evidence(directory)
    plan = evidence.data("plan.json")
    require(type(plan["format"]) is int and plan["format"] == 1 and plan["worktree"] == "", "clean campaign")
    require(plan["schedule"] == [list(pair) for pair in SCHEDULE] and plan["solvers"] == list(SOLVERS), "fixed complete schedule")
    require(set(plan["snapshots"]) == set(SNAPSHOTS), "complete campaign audit snapshots")
    for name, sha in plan["snapshots"].items():
        require(digest(evidence.read("snapshots/scripts/" + name)) == sha == digest(Path(__file__).with_name(name).read_bytes()), "captured and running auditor identity")
    require(plan["runnerSha256"] == plan["snapshots"]["measure-extra-formal.py"], "campaign runner identity")
    common, canonical, rows, reports = {}, {}, {name: [] for name in COLUMNS}, []
    for phase, iteration in SCHEDULE:
        for solver in SOLVERS:
            label = f"{phase}-{iteration}/{solver}"
            item = Evidence(evidence.path(label))
            report = audit_pair(item.directory, solver, plan["commit"])
            reports.append({"phase": phase, "iteration": iteration, "solver": solver, **report})
            for name in COLUMNS:
                folder = name + "/"
                meta = item.data(folder + ("metadata.json" if name == "controls" else "metadata-final.json"))
                require(meta["snapshots"]["scripts/measure-extra-formal.py"] == plan["runnerSha256"], "executed campaign runner")
                identity = {key: meta[key] for key in ["sources", "snapshots", "probes", "node"]}
                identity["pyodide"] = meta["pyodide" if name == "smtbmc" else "pyodidePackage"]
                if name == "smtbmc":
                    identity["models"] = meta["models"]
                else:
                    identity["yosys"] = meta["yosys"]
                if name != "controls":
                    native = item.data(folder + "native-metadata.json")
                    identity["native"] = {key: native[key] for key in ["python", "yosys", "sources", "pins"]}
                key = (solver, name)
                common.setdefault(key, identity)
                require(encoded(identity) == encoded(common[key]), "source, runtime, solver or harness changed between samples")
                sample = item.data(folder + "results.json")["rows"]
                if name == "sby":
                    hashes = {condition["condition"]: condition["canonicalSha256"] for condition in report[name]["conditions"]}
                elif name == "smtbmc":
                    hashes = [{field: row[field] for field in ["solver", "case", "phase", "status", "nativeExitCode", "pyodideExitCode", "modelSha256", "solverSha256", "nativeStdoutSha256", "pyodideStdoutSha256", "files"]} for row in sample]
                else:
                    hashes = [{field: row[field] for field in ["condition", "solver", "status", "exitCode", "sbyStatus", "solverSha256", "error"]} for row in sample]
                canonical.setdefault(key, hashes)
                require(hashes == canonical[key], "A/A or repeated semantic artifacts differ")
                for raw in sample:
                    row = {"series": phase, "iteration": iteration, **raw}
                    if name == "smtbmc":
                        require(raw.get("error") in [None, ""], "SMTBMC execution error")
                        row["error"] = None
                    if name == "sby":
                        row["nativeElapsedMs"] = item.data(folder + solver + "-" + raw["case"] + "/native.json")["elapsedMs"]
                    rows[name].append(row)
    tables = {}
    for name, values in rows.items():
        columns = COLUMNS[name]
        raw = csv_bytes(values, columns)
        formal = [row for row in values if row["series"] == "run"]
        timings = []
        fields = ["solver", "case", "phase"] if name == "smtbmc" else ["solver", "case"] if name == "sby" else ["solver", "condition"]
        identities = sorted({tuple(row[field] for field in fields) for row in formal})
        for condition in identities:
            group = [row for row in formal if tuple(row[field] for field in fields) == condition]
            require(len(group) == 5 and all(row["error"] is None for row in group), "five valid samples per condition")
            timing = {}
            for field in (["nativeElapsedMs", "pyodideElapsedMs"] if name == "smtbmc" else ["nativeElapsedMs", "elapsedMs"] if name == "sby" else ["elapsedMs"]):
                numbers = [row[field] for row in group]
                require(all(SBY.positive(number) for number in numbers), "finite positive samples")
                timing[field] = {"minMs": min(numbers), "medianMs": statistics.median(numbers), "maxMs": max(numbers)}
            timings.append({**dict(zip(fields, condition)), "samples": 5, **timing})
        tables[name] = {"rows": len(values), "columns": len(columns), "formalRows": len(formal), "aaRows": len(values) - len(formal), "csvSha256": digest(raw), "timings": timings}
        if saved:
            require(evidence.read(name + ".csv") == raw, "all campaign CSV cells")
        else:
            with (Path(directory) / (name + ".csv")).open("xb") as stream:
                stream.write(raw)
    summary = {"status": "pass", "commit": plan["commit"], "pairs": len(SCHEDULE) * len(SOLVERS), "tables": tables}
    if saved:
        require(encoded(evidence.data("summary.json")) == encoded(summary), "saved summary")
        require(encoded(evidence.data("audits.json")) == encoded(reports), "saved independent audits")
    else:
        write(Path(directory) / "summary.json", summary)
        write(Path(directory) / "audits.json", reports)
    return summary


def check_clean(commit):
    require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == commit and subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True) == "", "changed measurement checkout")


def deduplicate_inputs(directory, objects):
    for file in directory.rglob("*"):
        if file.is_symlink() or not file.is_file() or "inputs" not in file.parts:
            continue
        sha = digest(file.read_bytes())
        if sha not in objects:
            objects[sha] = file
            continue
        target = objects[sha]
        require(file.read_bytes() == target.read_bytes(), "deduplication bytes")
        temporary = file.with_name(file.name + ".verified-link")
        os.link(target, temporary)
        os.replace(temporary, file)


def measure(args):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    check_clean(commit)
    out = Path(args.out).resolve()
    out.mkdir()
    snapshots = out / "snapshots/scripts"
    snapshots.mkdir(parents=True)
    for name in SNAPSHOTS:
        (snapshots / name).write_bytes(Path(__file__).with_name(name).read_bytes())
    write(out / "plan.json", {"format": 1, "worktree": "", "commit": commit, "schedule": SCHEDULE, "solvers": SOLVERS,
                             "snapshots": {name: digest((snapshots / name).read_bytes()) for name in SNAPSHOTS},
                             "runnerSha256": digest(Path(__file__).read_bytes()), "command": sys.argv,
                             "submodules": subprocess.check_output(["git", "submodule", "status"], cwd=ROOT, text=True)})
    commands, objects = [], {}
    try:
        for phase, iteration in SCHEDULE:
            for solver in SOLVERS:
                directory = out / f"{phase}-{iteration}" / solver
                directory.mkdir(parents=True)
                native = ["--formal", "--solver", solver, "--probes", args.probes]
                shared = native + ["--sources", args.sources, "--synth", args.synth]
                for name, script, options in [
                    ("native", "probe-upstream-formal.mjs", native),
                    ("smtbmc", "probe-formal-python-engine.mjs", ["--formal", "--solver", solver, "--probes", args.probes, "--sources", args.sources, "--baseline", str(directory / "native")]),
                    ("sby", "probe-formal-sby.mjs", shared + ["--baseline", str(directory / "native")]),
                    ("controls", "probe-formal-controls.mjs", shared),
                ]:
                    check_clean(commit)
                    command = ["node", "scripts/" + script, *options, "--out", str(directory / name)]
                    commands.append(command)
                    with (directory / (name + ".log")).open("xb") as stream:
                        subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1800)
                    deduplicate_inputs(directory / name, objects)
                report = audit_pair(directory, solver, commit)
                write(directory / "audit.json", report)
                print(encoded({"sample": f"{phase}-{iteration}", "solver": solver, "status": "pass"}), flush=True)
        check_clean(commit)
        write(out / "commands.json", commands)
        summary = audit_campaign(out, saved=False)
        audit_campaign(out)
        return summary
    except Exception as error:
        write(out / "failure.json", {"error": str(error), "commands": commands})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["out", "sources", "probes", "synth"]:
        parser.add_argument("--" + name, required=name == "out")
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    if not args.audit_only:
        require(args.sources and args.probes and args.synth, "source, solver and Yosys assets required")
    summary = audit_campaign(args.out) if args.audit_only else measure(args)
    print(encoded({"status": summary["status"], "commit": summary["commit"], "tables": {key: {name: value for name, value in item.items() if name != "timings"} for key, item in summary["tables"].items()}}))
