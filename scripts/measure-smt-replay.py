#!/usr/bin/env python3
"""元VerilogのSMT反例再実行を同一版でA/A 2回・正式5回測る。"""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import re
import statistics
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("campaign_smt_replay_audit", Path(__file__).with_name("audit-smt-replay.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
require, digest, Evidence = AUDIT.require, AUDIT.digest, AUDIT.Evidence
encoded = AUDIT.TRACE.encoded
SOLVERS = ("yices2", "z3", "bitwuzla", "boolector")
SCHEDULE = [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)]
SCRIPTS = ("measure-smt-replay.py", "audit-smt-replay.py", "negative-smt-replay.py", "audit-formal-trace.py",
           "audit-formal-sby.py", "sby-artifact-audit.py", "formal-solver-audit.py")
SNAPSHOTS = ["scripts/" + name for name in SCRIPTS] + ["vendor/yosys/backends/smt2/smtio.py"]
COLUMNS = ["series", "iteration", *AUDIT.COLUMNS]


def write(path, value):
    with Path(path).open("x") as stream:
        stream.write(encoded(value) + "\n")


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=COLUMNS, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: row[key] for key in COLUMNS} for row in rows)
    return stream.getvalue().encode()


def normalized_vcd(raw):
    matches = re.findall(rb"\$date\s+[^$]+\$end", raw)
    require(len(matches) == 1, "one recorded replay VCD date")
    return raw.replace(matches[0], b"$date RECORDED $end", 1)


def audit(directory, saved=True):
    evidence = Evidence(directory)
    plan = evidence.data("plan.json")
    require(plan["kind"] == "smt-replay-v1" and type(plan["format"]) is int and plan["format"] == 1 and plan["worktree"] == "", "clean replay campaign")
    require(plan["schedule"] == [list(pair) for pair in SCHEDULE] and plan["solvers"] == list(SOLVERS), "complete replay schedule")
    require(set(plan["snapshots"]) == set(SNAPSHOTS), "complete replay audit closure")
    for name, sha in plan["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha == digest((ROOT / name).read_bytes()), "trusted captured auditor: " + name)
    rows, reports, common, canonical = [], [], {}, {}
    for series, iteration in SCHEDULE:
        for solver in SOLVERS:
            prefix = f"{series}-{iteration}/{solver}/"
            report = AUDIT.audit(evidence.path(prefix + "replay"), formal=True)
            meta = evidence.data(prefix + "replay/metadata.json")
            require(meta["commit"] == plan["commit"] and meta["solvers"] == [solver], "same clean sample commit")
            reports.append({"series": series, "iteration": iteration, "solver": solver, **report})
            identity = {name: meta[name] for name in ["assets", "snapshots", "builds", "versions", "sourcePins", "node", "python", "pyodide", "submodules", "host", "environment"]}
            identity["solverBuilds"] = {runtime: meta["probes"][solver][runtime] for runtime in ["native", "wasi"]}
            common.setdefault(solver, identity)
            require(encoded(identity) == encoded(common[solver]), "unchanged source, tools and host across replay samples")
            semantic = []
            for row in evidence.data(prefix + "replay/results.json")["rows"]:
                fields = {key: value for key, value in row.items() if key != "elapsedMs"}
                if row["runtime"] in {"native", "wasm"}:
                    label = f"{solver}-{row['case']}/{row['origin']}-formal_trace/replay-{row['runtime']}/"
                    raw = evidence.read(prefix + "replay/" + label + "replay.vcd")
                    fields["vcdSha256"] = digest(normalized_vcd(raw))
                semantic.append(fields)
                rows.append({"series": series, "iteration": iteration, **row})
            canonical.setdefault(solver, semantic)
            require(encoded(semantic) == encoded(canonical[solver]), "A/A and repeated semantic artifacts; only raw VCD date and timing may vary")
    timings = []
    keys = ["solver", "case", "origin", "runtime", "phase"]
    for identity in sorted({tuple(row[key] for key in keys) for row in rows}):
        group = [row for row in rows if row["series"] == "run" and tuple(row[key] for key in keys) == identity]
        require(len(group) == 5, "five audited samples per replay condition")
        values = [row["elapsedMs"] for row in group]
        require(all(AUDIT.TRACE.positive(value) for value in values), "finite positive replay timings")
        timings.append({**dict(zip(keys, identity)), "samples": 5, "minMs": min(values), "medianMs": statistics.median(values), "maxMs": max(values)})
    raw = csv_bytes(rows)
    summary = {"status": "pass", "commit": plan["commit"], "rows": len(rows), "columns": len(COLUMNS),
               "aaRows": 424, "formalRows": 1060, "csvSha256": digest(raw), "timings": timings}
    require(len(rows) == 1484 and sum(row["series"] == "aa" for row in rows) == 424, "complete replay matrix")
    if saved:
        require(evidence.read("replay.csv") == raw and encoded(evidence.data("audits.json")) == encoded(reports)
                and encoded(evidence.data("summary.json")) == encoded(summary), "all saved replay cells and statistics")
    else:
        with evidence.path("replay.csv").open("xb") as stream:
            stream.write(raw)
        write(evidence.path("audits.json"), reports)
        write(evidence.path("summary.json"), summary)
    return summary


def measure(args):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

    def clean():
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == commit
                and subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True) == "", "changed replay campaign checkout")

    clean()
    out = Path(args.out).resolve()
    require(not out.exists(), "refuse to overwrite replay campaign")
    out.mkdir()
    for name in SNAPSHOTS:
        target = out / "snapshots" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    write(out / "plan.json", {"kind": "smt-replay-v1", "format": 1, "commit": commit, "worktree": "", "schedule": SCHEDULE,
                             "solvers": SOLVERS, "snapshots": {name: digest((ROOT / name).read_bytes()) for name in SNAPSHOTS}, "command": sys.argv})
    commands = []
    try:
        for series, iteration in SCHEDULE:
            for solver in SOLVERS:
                directory = out / f"{series}-{iteration}" / solver
                directory.mkdir(parents=True)
                for name, script, options in [
                    ("native", "probe-upstream-formal.mjs", ["--suite", "replay", "--solver", solver, "--probes", args.probes]),
                    ("replay", "probe-smt-replay-cases.mjs", ["--solver", solver, "--probes", args.probes, "--sources", args.sources, "--baseline", str(directory / "native")]),
                ]:
                    clean()
                    command = ["node", "scripts/" + script, "--formal", *options, "--out", str(directory / name)]
                    commands.append(command)
                    with (directory / (name + ".log")).open("xb") as stream:
                        subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1800)
                report = AUDIT.audit(directory / "replay", formal=True)
                write(directory / "audit.json", report)
                print(encoded({"series": series, "iteration": iteration, "solver": solver, **report}), flush=True)
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
    require(args.audit_only or args.sources and args.probes, "Python source and solver assets required")
    report = audit(args.out) if args.audit_only else measure(args)
    print(encoded({name: value for name, value in report.items() if name != "timings"}))
