#!/usr/bin/env python3
"""Run and independently audit two A/A and five complete SBY control matrices."""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import statistics


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("controls_audit", ROOT / "scripts/audit-formal-controls.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
SPEC_WITNESS = importlib.util.spec_from_file_location("witness_audit", ROOT / "scripts/audit-formal-witness.py")
WITNESS = importlib.util.module_from_spec(SPEC_WITNESS)
SPEC_WITNESS.loader.exec_module(WITNESS)
SCHEDULE = [("aa", 1), ("aa", 2)] + [("run", i) for i in range(1, 6)]


def write(path, value):
    with path.open("x") as stream:
        json.dump(value, stream, ensure_ascii=True, indent=2, allow_nan=False)
        stream.write("\n")


def audit_campaign(directory):
    evidence = AUDIT.Evidence(directory)
    plan = evidence.data("plan.json")
    AUDIT.require(plan["schedule"] == [list(pair) for pair in SCHEDULE] and plan["worktree"] == "", "fixed clean campaign")
    reports, rows, common, witness_reports, witness_rows, witness_identity = [], [], None, [], [], None
    for phase, iteration in SCHEDULE:
        label = f"{phase}-{iteration}"
        report = AUDIT.audit(evidence.path(label))
        meta = evidence.data(label + "/metadata.json")
        AUDIT.require(report["preliminary"] is False and report["commit"] == plan["commit"], "formal identical revision")
        identity = {key: meta[key] for key in ["snapshots", "sources", "yosys", "probes", "node", "pyodidePackage", "deadlineMs", "cleanupDeadlineMs"]}
        if common is None:
            common = identity
        AUDIT.require(identity == common, "runtime, source, binary or harness changed between repetitions")
        reports.append(report)
        for row in evidence.data(label + "/results.json")["rows"]:
            rows.append({"phase": phase, "iteration": iteration, **row})
        witness_label = label + "-witness"
        witness = WITNESS.audit(evidence.path(witness_label))
        witness_meta = evidence.data(witness_label + "/metadata.json")
        AUDIT.require(witness["preliminary"] is False and witness["commit"] == plan["commit"], "formal witness revision")
        witness_common = {key: witness_meta[key] for key in ["snapshots", "node", "pyodidePackage", "python", "yosys"]}
        if witness_identity is None:
            witness_identity = witness_common
        AUDIT.require(witness_common == witness_identity and (not witness_reports or witness["outputs"] == witness_reports[0]["outputs"]), "witness identity or output changed")
        model = evidence.read(label + "/yices2-bounded-pass/output/result/model/design_prep.il")
        AUDIT.require(evidence.read(witness_label + "/native/design_prep.il") == model, "real SBY preparation for map generation")
        witness_reports.append(witness)
        for row in evidence.data(witness_label + "/results.json")["rows"]:
            witness_rows.append({"phase": phase, "iteration": iteration, **row})
    columns = ["phase", "iteration", *AUDIT.COLUMNS]
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=columns, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: "" if value is None else value for key, value in row.items()} for row in rows)
    raw = out.getvalue().encode()
    target = directory / "results.csv"
    if target.exists():
        AUDIT.require(target.read_bytes() == raw, "campaign CSV differs from raw evidence")
    else:
        target.write_bytes(raw)
    witness_stream = io.StringIO(newline="")
    witness_writer = csv.DictWriter(witness_stream, fieldnames=["phase", "iteration", *WITNESS.COLUMNS], quoting=csv.QUOTE_ALL, lineterminator="\n")
    witness_writer.writeheader()
    witness_writer.writerows(witness_rows)
    witness_raw = witness_stream.getvalue().encode()
    target = directory / "witness-results.csv"
    if target.exists():
        AUDIT.require(target.read_bytes() == witness_raw, "witness campaign CSV differs")
    else:
        target.write_bytes(witness_raw)
    timings = {}
    for condition in sorted({row["condition"] for row in rows}):
        values = [row["elapsedMs"] for row in rows if row["phase"] == "run" and row["condition"] == condition]
        timings[condition] = {"min": min(values), "median": statistics.median(values), "max": max(values)}
    summary = {"status": "pass", "commit": plan["commit"], "pairs": len(reports), "aaRows": 46, "formalRows": 115,
               "rows": len(rows), "columns": len(columns), "workers": sum(report["workers"] for report in reports),
               "files": sum(report["files"] for report in reports), "csvSha256": AUDIT.digest(raw), "elapsedMs": timings,
               "witnessRows": len(witness_rows), "witnessWorkers": sum(report["workers"] for report in witness_reports),
               "witnessFiles": sum(report["files"] for report in witness_reports), "witnessCsvSha256": AUDIT.digest(witness_raw)}
    target = directory / "summary.json"
    if target.exists():
        AUDIT.require(evidence.data("summary.json") == summary, "campaign summary differs from raw evidence")
    else:
        write(target, summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["sources", "probes", "synth", "yosys", "out"]:
        parser.add_argument("--" + name, type=Path, required=name == "out")
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    if not args.audit_only:
        AUDIT.require(all([args.sources, args.probes, args.synth, args.yosys]), "missing input directories")
        git = lambda *items: subprocess.check_output(["git", *items], cwd=ROOT, text=True).strip()
        AUDIT.require(git("status", "--porcelain") == "", "clean formal campaign required")
        args.out.mkdir()
        write(args.out / "plan.json", {"commit": git("rev-parse", "HEAD"), "worktree": "", "schedule": SCHEDULE})
        for phase, iteration in SCHEDULE:
            label = f"{phase}-{iteration}"
            command = ["node", "scripts/probe-formal-controls.mjs", "--formal", "--sources", str(args.sources),
                       "--probes", str(args.probes), "--synth", str(args.synth), "--out", str(args.out / label)]
            with (args.out / (label + ".log")).open("xb") as log:
                subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
            report = AUDIT.audit(args.out / label)
            write(args.out / (label + "-audit.json"), report)
            witness_command = ["node", "scripts/probe-formal-witness.mjs", "--formal", "--sources", str(args.sources),
                               "--model", str(args.out / label / "yices2-bounded-pass/output/result/model/design_prep.il"),
                               "--yosys", str(args.yosys), "--out", str(args.out / (label + "-witness"))]
            with (args.out / (label + "-witness.log")).open("xb") as log:
                subprocess.run(witness_command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, check=True)
            write(args.out / (label + "-witness-audit.json"), WITNESS.audit(args.out / (label + "-witness")))
            print(label, json.dumps(report, sort_keys=True), flush=True)
    print(json.dumps(audit_campaign(args.out), sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
