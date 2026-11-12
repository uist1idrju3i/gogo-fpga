#!/usr/bin/env python3
"""Yosys SAT 形式検証を同一 commit で A/A 2回・正式5回測り、全行を監査して CSV にする。"""

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
SPEC = importlib.util.spec_from_file_location("campaign_sat_formal_audit", Path(__file__).with_name("audit-sat-formal.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
require, digest, Evidence = AUDIT.require, AUDIT.digest, AUDIT.Evidence
SCHEDULE = [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)]
KINDS = ("verdict", "error")
SNAPSHOTS = ["scripts/measure-sat-formal.py", "scripts/audit-sat-formal.py", "scripts/negative-sat-formal.py",
             "scripts/probe-sat-formal.mjs", "tests/synth/formal-sat-cases.mjs", "web/lib/formal-sat.mjs",
             "web/lib/formal-replay.mjs"]
COLUMNS = ["trialId", "series", "iteration", "kind", "commit", "engine", "solver", "case", "mode", "bound", "runtime",
           "runtimeIndex", "binarySha256", "inputSha256", "expected", "actual", "status", "exitCode", "elapsedMs",
           "wasmMemoryBytes", "distributionBytes", "replay", "negative", "logSha256"]


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write(path, value):
    with Path(path).open("x") as stream:
        stream.write(encoded(value) + "\n")


def order_for(iteration):
    return "native-first" if iteration % 2 else "wasm-first"


def csv_bytes(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=COLUMNS, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: "" if row[key] is None else row[key] for key in COLUMNS} for row in rows)
    return stream.getvalue().encode()


def replay_outputs(evidence, prefix, case):
    """反例再実行の環境に依存しない出力（stdout・WASM 実行結果・正規化 VCD）を集める。"""
    names = []
    for runtime in AUDIT.RUNTIMES:
        base = f"{prefix}/{case}/{runtime}-replay/"
        if not evidence.path(base).exists():
            continue
        names += [base + "vvp.stdout", base + "wasm-execution.json", base + "negative-result.json", base + "replay.v"]
    return {name.split("/", 2)[2]: digest(evidence.read(name)) for name in names}


def audit(directory, saved=True):
    evidence = Evidence(directory)
    plan = evidence.data("plan.json")
    require(plan["kind"] == "sat-formal-campaign-v1" and AUDIT.integer(plan["format"]) and plan["format"] == 1
            and plan["worktree"] == "", "clean SAT campaign")
    require(plan["schedule"] == [list(pair) for pair in SCHEDULE] and plan["kinds"] == list(KINDS), "complete SAT schedule")
    require(set(plan["snapshots"]) == set(SNAPSHOTS), "complete SAT audit closure")
    for name, sha in plan["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha, "captured script: " + name)
        if saved:
            require(sha == digest((ROOT / name).read_bytes()), "trusted auditor matches checkout: " + name)
    series_names = {f"{series}-{iteration}" for series, iteration in SCHEDULE}
    root_entries = {"plan.json", "snapshots", "commands.json", "sat-formal.csv", "audits.json", "summary.json", *series_names}
    present = {path.name for path in evidence.root.iterdir()}
    require(present == root_entries or (not saved and present == root_entries - {"sat-formal.csv", "audits.json", "summary.json"}),
            "unexpected campaign entries")
    expected_commands = [["node", "scripts/probe-sat-formal.mjs", "--kind", kind, "--order", order_for(iteration), "--out",
                          f"{series}-{iteration}/{kind}"] for series, iteration in SCHEDULE for kind in KINDS]
    commands = evidence.data("commands.json")
    require(isinstance(commands, list) and len(commands) == len(expected_commands)
            and [command[:7] + ["/".join(Path(command[7]).parts[-2:])] for command in commands if len(command) == 8] == expected_commands,
            "recorded probe commands")
    for name in series_names:
        require({path.name for path in evidence.path(name).iterdir()} == {*KINDS, *(kind + ".log" for kind in KINDS)},
                "unexpected sample entries: " + name)
    rows, reports, identity, canonical, replay_canonical = [], [], None, {}, {}
    for series, iteration in SCHEDULE:
        for kind in KINDS:
            prefix = f"{series}-{iteration}/{kind}"
            report = AUDIT.audit(evidence.path(prefix))
            meta = evidence.data(prefix + "/metadata.json")
            result = evidence.data(prefix + "/results.json")
            require(meta["commit"] == plan["commit"] and meta["order"] == order_for(iteration), "sample commit and alternation")
            reports.append({"series": series, "iteration": iteration, "kind": kind, **report})
            current = {name: meta[name] for name in ["binaries", "iverilog", "vvpVersion", "node", "host"]}
            identity = identity or current
            require(encoded(current) == encoded(identity), "unchanged binaries and host across samples")
            semantic = [{key: value for key, value in row.items() if key not in {"elapsedMs", "runtimeIndex"}}
                        for row in sorted(result["rows"], key=lambda row: (row["case"], row["runtime"]))]
            semantic.append(sorted(result["replays"], key=lambda item: (item["case"], item["runtime"])))
            semantic.append(sorted(result["failures"], key=lambda item: (item["case"], item["runtime"])))
            canonical.setdefault(kind, semantic)
            require(encoded(semantic) == encoded(canonical[kind]), "A/A and repeated semantic results; only timing may vary")
            replayed = {(item["case"], item["runtime"]) for item in result["replays"]}
            for case in meta["cases"]:
                outputs = replay_outputs(evidence, prefix, case)
                replay_canonical.setdefault((kind, case), outputs)
                require(outputs == replay_canonical[(kind, case)], "repeated replay outputs: " + case)
            for row in result["rows"]:
                key = (row["case"], row["runtime"])
                rows.append({
                    "trialId": f"{series}-{iteration}/{kind}/{row['case']}/{row['runtime']}",
                    "series": series, "iteration": iteration, "kind": kind, "commit": meta["commit"],
                    "engine": "yosys-sat", "solver": "yosys-builtin", "case": row["case"], "mode": row["mode"],
                    "bound": row["depth"], "runtime": row["runtime"], "runtimeIndex": row["runtimeIndex"],
                    "binarySha256": meta["binaries"]["yosys-" + row["runtime"]]["sha256"],
                    "inputSha256": row["sourceSha256"], "expected": row["expected"], "actual": row["actual"],
                    "status": "pass", "exitCode": row["exitCode"], "elapsedMs": row["elapsedMs"],
                    "wasmMemoryBytes": row["wasmMemoryBytes"], "distributionBytes": row["distributionBytes"],
                    "replay": "verified" if key in replayed else "not-applicable",
                    "negative": "rejected" if key in replayed else "not-applicable",
                    "logSha256": row["logSha256"],
                })
    timings = []
    for kind in KINDS:
        table = AUDIT.CASES if kind == "verdict" else AUDIT.ERROR_CASES
        for case in table:
            for runtime in AUDIT.RUNTIMES:
                group = [row for row in rows if row["series"] == "run" and row["kind"] == kind
                         and row["case"] == case and row["runtime"] == runtime]
                require(len(group) == 5, "five audited samples per condition")
                values = [row["elapsedMs"] for row in group]
                timings.append({"kind": kind, "case": case, "runtime": runtime, "samples": 5,
                                "minMs": min(values), "medianMs": statistics.median(values), "maxMs": max(values)})
    per_iteration = 2 * (len(AUDIT.CASES) + len(AUDIT.ERROR_CASES))
    require(len(rows) == per_iteration * len(SCHEDULE), "complete SAT matrix")
    raw = csv_bytes(rows)
    summary = {"status": "pass", "commit": plan["commit"], "rows": len(rows), "columns": len(COLUMNS),
               "aaRows": per_iteration * 2, "formalRows": per_iteration * 5, "csvSha256": digest(raw),
               "replays": sum(row["replay"] == "verified" for row in rows), "timings": timings}
    if saved:
        require(evidence.read("sat-formal.csv") == raw and encoded(evidence.data("audits.json")) == encoded(reports)
                and encoded(evidence.data("summary.json")) == encoded(summary), "all saved SAT cells and statistics")
    else:
        with evidence.path("sat-formal.csv").open("xb") as stream:
            stream.write(raw)
        write(evidence.path("audits.json"), reports)
        write(evidence.path("summary.json"), summary)
    return summary


def measure(args):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()

    def clean():
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == commit
                and subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True) == "", "changed SAT campaign checkout")

    clean()
    out = Path(args.out).resolve()
    require(not out.exists(), "refuse to overwrite SAT campaign")
    out.mkdir(parents=True)
    for name in SNAPSHOTS:
        target = out / "snapshots" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / name).read_bytes())
    write(out / "plan.json", {"kind": "sat-formal-campaign-v1", "format": 1, "commit": commit, "worktree": "",
                             "schedule": SCHEDULE, "kinds": KINDS,
                             "snapshots": {name: digest((ROOT / name).read_bytes()) for name in SNAPSHOTS}, "command": sys.argv})
    commands = []
    try:
        for series, iteration in SCHEDULE:
            for kind in KINDS:
                directory = out / f"{series}-{iteration}"
                directory.mkdir(exist_ok=True)
                clean()
                command = ["node", "scripts/probe-sat-formal.mjs", "--kind", kind, "--order", order_for(iteration),
                           "--out", str(directory / kind)]
                commands.append(command)
                with (directory / (kind + ".log")).open("xb") as stream:
                    subprocess.run(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=1800)
                report = AUDIT.audit(directory / kind)
                print(encoded({"series": series, "iteration": iteration, **report}), flush=True)
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
    parser.add_argument("--audit-only", action="store_true")
    args = parser.parse_args()
    report = audit(args.out) if args.audit_only else measure(args)
    print(encoded({name: value for name, value in report.items() if name != "timings"}))
