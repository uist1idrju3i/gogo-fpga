#!/usr/bin/env python3
"""Measure and independently audit seven clean, complete native/Pyodide SBY pairs."""

import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("sby_audit", ROOT / "scripts/audit-formal-sby.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
require = AUDIT.require
SCHEDULE = [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)]
COLUMNS = ["phase", "iteration", "nativeElapsedMs"] + AUDIT.COLUMNS


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def json_file(path, value):
    with Path(path).open("x") as stream:
        json.dump(value, stream, ensure_ascii=True, indent=2, allow_nan=False)
        stream.write("\n")


def csv_bytes(rows):
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: AUDIT.cell(row[key]) for key in COLUMNS} for row in rows)
    return out.getvalue().encode()


def audit_campaign(directory):
    evidence = AUDIT.Evidence(directory)
    plan = evidence.data("plan.json")
    require(type(plan["format"]) is int and plan["format"] == 1 and plan["worktree"] == "", "clean campaign provenance")
    require(encoded(plan["schedule"]) == encoded(SCHEDULE), "predeclared complete schedule")
    rows, reports, identity, canonical = [], [], None, None
    for phase, iteration in SCHEDULE:
        label = f"{phase}-{iteration}"
        run = evidence.path(label + "/runtime")
        report = AUDIT.audit(run)
        require(report["preliminary"] is False and report["commit"] == plan["commit"], "same formal commit")
        data = AUDIT.Evidence(run)
        meta, native = data.data("metadata-final.json"), data.data("native-metadata.json")
        require(meta["snapshots"]["scripts/measure-formal-sby.py"] == plan["runnerSha256"], "same measured runner")
        actual = {"sources": meta["sources"], "yosys": meta["yosys"], "probes": meta["probes"], "snapshots": meta["snapshots"],
                  "node": meta["node"], "pyodidePackage": meta["pyodidePackage"], "python": native["python"],
                  "nativeYosys": native["yosys"], "nativeSources": native["sources"], "nativePins": native["pins"]}
        hashes = {item["condition"]: item["canonicalSha256"] for item in report["conditions"]}
        if identity is None:
            identity, canonical = actual, hashes
        require(encoded(actual) == encoded(identity), "same source, binary and runtime across repeats")
        require(hashes == canonical, "A/A and repeated canonical artifacts differ")
        reports.append({"phase": phase, "iteration": iteration, **report})
        for row in data.data("results.json")["rows"]:
            reference = data.data(row["solver"] + "-" + row["case"] + "/native.json")
            rows.append({"phase": phase, "iteration": iteration, "nativeElapsedMs": reference["elapsedMs"], **row})
    statistics_rows = []
    for solver, case in [(solver, case) for solver in ["yices2", "z3"] for case in AUDIT.CASES]:
        selected = [row for row in rows if row["phase"] == "run" and row["solver"] == solver and row["case"] == case]
        require(len(selected) == 5, "five independent samples per condition")
        timings = {}
        for name, column in [("native", "nativeElapsedMs"), ("pyodide", "elapsedMs")]:
            values = [row[column] for row in selected]
            require(all(AUDIT.positive(value) for value in values), "finite nonzero timings")
            timings[name] = {"minMs": min(values), "medianMs": statistics.median(values), "maxMs": max(values)}
        statistics_rows.append({"solver": solver, "case": case, "samples": 5, **timings})
    summary = {"status": "pass", "commit": plan["commit"], "pairs": len(SCHEDULE), "aaRows": 24, "formalRows": 60,
               "rows": len(rows), "columns": len(COLUMNS), "artifacts": sum(item["artifacts"] for item in reports),
               "csvSha256": AUDIT.digest(csv_bytes(rows)), "conditions": statistics_rows, "canonicalSha256": canonical}
    return rows, reports, summary


def check_clean(commit):
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    worktree = subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True)
    require(head == commit and worktree == "", "refuse changed experiment checkout")


def audit_saved_campaign(directory):
    rows, _, summary = audit_campaign(directory)
    evidence = AUDIT.Evidence(directory)
    require(evidence.read("results.csv") == csv_bytes(rows), "campaign raw CSV")
    require(encoded(evidence.data("summary.json")) == encoded(summary), "campaign summary")
    return summary


def measure(args):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    check_clean(commit)
    out = Path(args.out).resolve()
    out.mkdir()
    plan = {"format": 1, "worktree": "", "commit": commit, "schedule": SCHEDULE, "command": sys.argv,
            "runnerSha256": AUDIT.digest(Path(__file__).read_bytes()), "platform": platform.platform(),
            "cpuCount": os.cpu_count(), "memory": Path("/proc/meminfo").read_text(), "environment": {
                name: os.environ.get(name) for name in ["PYTHON", "BUILD_ROOT", "WASM_BUILD_ROOT"]}}
    json_file(out / "plan.json", plan)
    commands, canonical = [], None
    try:
        for phase, iteration in SCHEDULE:
            label = f"{phase}-{iteration}"
            directory = out / label
            directory.mkdir()
            pair_commands = [
                (["node", "scripts/probe-upstream-formal.mjs", "--formal", "--probes", args.probes, "--out", str(directory / "native")], directory / "native.log"),
                (["node", "scripts/probe-formal-sby.mjs", "--formal", "--sources", args.sources, "--probes", args.probes,
                  "--synth", args.synth, "--baseline", str(directory / "native"), "--out", str(directory / "runtime")], directory / "runtime.log"),
            ]
            for command, log in pair_commands:
                check_clean(commit)
                commands.append(command)
                with log.open("xb") as stream:
                    subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1800)
            check_clean(commit)
            report = AUDIT.audit(directory / "runtime")
            json_file(directory / "independent-audit.json", report)
            hashes = {item["condition"]: item["canonicalSha256"] for item in report["conditions"]}
            if canonical is None:
                canonical = hashes
            require(hashes == canonical, "A/A or repeated artifacts differ; stop before next sample")
            print(encoded({"sample": label, **{key: value for key, value in report.items() if key != "conditions"}}), flush=True)
        rows, reports, summary = audit_campaign(out)
        json_file(out / "all-independent-audits.json", reports)
        with (out / "results.csv").open("xb") as stream:
            stream.write(csv_bytes(rows))
        json_file(out / "summary.json", summary)
        json_file(out / "commands.json", commands)
        check_clean(commit)
        return summary
    except Exception as error:
        json_file(out / "failure.json", {"error": str(error), "commands": commands})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources")
    parser.add_argument("--probes")
    parser.add_argument("--synth")
    parser.add_argument("--out", required=True)
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    if args.audit_only:
        summary = audit_saved_campaign(args.out)
    else:
        require(args.sources and args.probes and args.synth, "sources, probes and synth are required")
        summary = measure(args)
    print(encoded({key: value for key, value in summary.items() if key not in ["conditions", "canonicalSha256"]}))
