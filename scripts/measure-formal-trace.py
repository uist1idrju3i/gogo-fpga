#!/usr/bin/env python3
"""SMT記録境界を固定した同一版でA/A 2回・正式5回測定する。"""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import statistics
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("campaign_trace_audit", Path(__file__).with_name("audit-formal-trace.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
require, digest, encoded, Evidence = AUDIT.require, AUDIT.digest, AUDIT.encoded, AUDIT.Evidence
SCHEDULE = [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)]
GROUPS = {"default": ("yices2", "z3"), "bitwuzla": ("bitwuzla",), "boolector": ("boolector",)}
SCRIPTS = ("measure-formal-trace.py", "audit-formal-trace.py", "audit-formal-sby.py", "sby-artifact-audit.py", "formal-solver-audit.py", "negative-formal-trace.py")
SNAPSHOTS = ["scripts/" + name for name in SCRIPTS] + ["vendor/yosys/backends/smt2/smtio.py"]
COLUMNS = ["series", "iteration", *AUDIT.COLUMNS]


def write(path, value):
    with Path(path).open("x") as stream:
        stream.write(encoded(value) + "\n")


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=COLUMNS, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        writer.writerow({name: str(value).lower() if type(value) is bool else value for name, value in row.items()})
    return stream.getvalue().encode()


def audit(directory, saved=True):
    evidence = Evidence(directory)
    plan = evidence.data("plan.json")
    require(plan["kind"] == "formal-trace-v1" and type(plan["format"]) is int and plan["format"] == 1 and plan["worktree"] == "", "clean trace campaign")
    require(plan["schedule"] == [list(pair) for pair in SCHEDULE] and plan["groups"] == {name: list(solvers) for name, solvers in GROUPS.items()}, "complete campaign schedule")
    require(set(plan["snapshots"]) == set(SNAPSHOTS), "complete trusted audit closure")
    for name, sha in plan["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha == digest((ROOT / name).read_bytes()), "trusted captured source: " + name)
    rows, reports, common, canonical = [], [], {}, {}
    for series, iteration in SCHEDULE:
        for group, solvers in GROUPS.items():
            prefix = f"{series}-{iteration}/{group}/"
            report = AUDIT.audit(evidence.path(prefix + "trace"), solvers, formal=True)
            require(report["commit"] == plan["commit"], "campaign sample commit")
            reports.append({"series": series, "iteration": iteration, "group": group, **report})
            meta = evidence.data(prefix + "trace/metadata.json")
            identity = {name: meta[name] for name in ["sources", "snapshots", "node", "python", "pyodide", "submodules", "host", "sourcePins"]}
            identity["builds"] = {solver: {runtime: meta["probes"][solver][runtime] for runtime in ["native", "wasi"]} for solver in solvers}
            common.setdefault(group, identity)
            require(encoded(identity) == encoded(common[group]), "unchanged source, solver binaries and runtime across repetitions")
            semantic = []
            sample = evidence.data(prefix + "trace/results.json")["rows"]
            for row in sample:
                label = "-".join(row[name] for name in ["solver", "case", "phase"]) + "/" + row["runtime"] + "-" + row["entrypoint"] + "/"
                stdout = evidence.read(prefix + "trace/" + label + "stdout.log")
                normalized = AUDIT.re.sub(rb"^##\s+\d+:\d\d:\d\d\s+", b"## TIME ", stdout, flags=AUDIT.re.M)
                semantic.append({**{name: value for name, value in row.items() if name not in ["elapsedMs", "stdoutSha256"]}, "normalizedStdoutSha256": digest(normalized)})
                rows.append({"series": series, "iteration": iteration, **row})
            canonical.setdefault(group, semantic)
            require(semantic == canonical[group], "A/A and repeated semantic bytes")
    timings = []
    fields = AUDIT.COLUMNS[:5]
    for identity in sorted({tuple(row[name] for name in fields) for row in rows}):
        group = [row for row in rows if row["series"] == "run" and tuple(row[name] for name in fields) == identity]
        require(len(group) == 5 and all(row["error"] is None for row in group), "five valid formal samples")
        values = [row["elapsedMs"] for row in group]
        require(all(AUDIT.positive(value) for value in values), "positive finite timing values")
        timings.append({**dict(zip(fields, identity)), "samples": 5, "minMs": min(values), "medianMs": statistics.median(values), "maxMs": max(values)})
    raw = csv_bytes(rows)
    summary = {"status": "pass", "commit": plan["commit"], "rows": len(rows), "columns": len(COLUMNS), "aaRows": 256, "formalRows": 640,
               "csvSha256": digest(raw), "timings": timings}
    require(len(rows) == 896 and sum(row["series"] == "aa" for row in rows) == 256, "complete aggregate matrix")
    if saved:
        require(evidence.read("trace.csv") == raw and encoded(evidence.data("audits.json")) == encoded(reports)
                and encoded(evidence.data("summary.json")) == encoded(summary), "all saved campaign cells and statistics")
    else:
        with evidence.path("trace.csv").open("xb") as stream:
            stream.write(raw)
        write(evidence.path("audits.json"), reports)
        write(evidence.path("summary.json"), summary)
    return summary


def measure(args):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    def clean():
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == commit
                and subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True) == "", "changed measurement checkout")
    clean()
    out = Path(args.out).resolve()
    require(not out.exists(), "refuse to overwrite campaign evidence")
    out.mkdir()
    for name in SNAPSHOTS:
        target = out / "snapshots" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    write(out / "plan.json", {"kind": "formal-trace-v1", "format": 1, "commit": commit, "worktree": "", "schedule": SCHEDULE,
                             "groups": GROUPS, "snapshots": {name: digest((ROOT / name).read_bytes()) for name in SNAPSHOTS}, "command": sys.argv})
    commands = []
    try:
        for series, iteration in SCHEDULE:
            for group in GROUPS:
                directory = out / f"{series}-{iteration}" / group
                directory.mkdir(parents=True)
                selected = [] if group == "default" else ["--solver", group]
                for name, script, options in [
                    ("native", "probe-upstream-formal.mjs", selected + ["--probes", args.probes]),
                    ("trace", "probe-formal-trace.mjs", selected + ["--probes", args.probes, "--sources", args.sources, "--baseline", str(directory / "native")]),
                ]:
                    clean()
                    command = ["node", "scripts/" + script, "--formal", *options, "--out", str(directory / name)]
                    commands.append(command)
                    with (directory / (name + ".log")).open("xb") as stream:
                        subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1800)
                report = AUDIT.audit(directory / "trace", GROUPS[group], formal=True)
                write(directory / "audit.json", report)
                print(encoded({"series": series, "iteration": iteration, "group": group, **report}), flush=True)
        clean()
        write(out / "commands.json", commands)
        report = audit(out, saved=False)
        audit(out)
        return report
    except Exception as error:
        write(out / "failure.json", {"error": str(error), "commands": commands})
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--sources")
    parser.add_argument("--probes")
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    if not args.audit_only:
        require(args.sources and args.probes, "source and solver assets required")
    summary = audit(args.out) if args.audit_only else measure(args)
    print(encoded({name: value for name, value in summary.items() if name != "timings"}))
