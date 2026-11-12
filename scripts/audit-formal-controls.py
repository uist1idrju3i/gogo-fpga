#!/usr/bin/env python3
"""Derive each SBY control column from raw transport, worker events, and files."""

import argparse
import base64
import csv
import hashlib
import importlib.util
import io
import json
import math
from pathlib import Path
import re


SPEC = importlib.util.spec_from_file_location("sby_audit", Path(__file__).with_name("audit-formal-sby.py"))
SBY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SBY)
require, digest, Evidence = SBY.require, SBY.digest, SBY.Evidence
COLUMNS = "condition solver status exitCode sbyStatus elapsedMs files workers stopped solverWaits solverSha256 error".split()
NORMAL = {"bounded-pass": ("bmc-prefix", "PASS", 0), "engine-fail": ("bmc-violation", "FAIL", 2),
          "engine-unknown": ("prove-inconclusive", "UNKNOWN", 4)}
FAULTS = {"cancel": "cancelled", "timeout": "timeout", "crash": "crashed", "protocol": "protocol-error",
          "corrupt-delta": "runtime-error", "conflict-delta": "runtime-error"}
EXTRA_FAULTS = {"syntax-error": "runtime-error", "exit-code": "runtime-error"}
RESTRICTIONS = {"autotune": "Browser SBY requires -j 1", "jobs": "Browser SBY requires -j 1",
                "jobserver": "Jobserver helpers are not supported in the browser",
                "temporary": "Browser SBY requires -j 1", "links": "Browser SBY requires -j 1"}
SNAPSHOTS = {"scripts/probe-formal-controls.mjs", "scripts/audit-formal-controls.py", "scripts/audit-formal-sby.py",
             "scripts/sby-artifact-audit.py", "tests/synth/formal-control-cases.mjs", "tests/synth/formal-control-workers.mjs",
             "tests/synth/formal-controlled-python-worker.mjs", "tests/synth/formal-controlled-solver-worker.mjs"}


def rows_csv(rows):
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\n", quoting=csv.QUOTE_ALL)
    writer.writerow(COLUMNS)
    for row in rows:
        writer.writerow("" if row[key] is None else str(row[key]) for key in COLUMNS)
    return out.getvalue().encode()


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def audit_case(evidence, meta, label, solver, condition):
    data = lambda name: evidence.data(label + "/" + name)
    text = lambda name: evidence.read(label + "/" + name).decode("utf-8", errors="strict")
    transport, events, workers, files = (data(name) for name in ["transport.json", "events.json", "workers.json", "files.json"])
    require(isinstance(events, list) and events and isinstance(workers, list) and workers, "missing worker observations")
    require(finite(transport["elapsedMs"]), "invalid elapsed time")
    ids = {worker["id"] for worker in workers}
    require(ids == set(range(len(workers))) and len(ids) == len(workers), "unique contiguous workers")
    previous = -1
    for event in events:
        require(event["worker"] in ids and type(event["ms"]) in (int, float) and math.isfinite(event["ms"]) and event["ms"] >= previous, "event chronology")
        previous = event["ms"]
    root = [worker for worker in workers if worker["root"] is True]
    require(len(root) == 1 and root[0]["id"] == 0 and root[0]["kind"] == "python", "single SBY root")
    for worker in workers:
        seen = [event for event in events if event["worker"] == worker["id"]]
        starts = [event for event in seen if event["event"] == "start"]
        exits = [event for event in seen if event["event"] == "exit"]
        require(len(starts) == len(exits) == 1 and starts[0]["kind"] == worker["kind"] and starts[0]["ms"] < exits[0]["ms"], "physical worker lifecycle")
        require(worker["exited"] is True and type(worker["stopped"]) is bool, "worker remains active")
        if worker["kind"] == "python":
            guards = [event for event in seen if event["event"] == "native-guards-installed"]
            require(len(guards) == 1 and guards[0]["resourceAvailable"] is False and guards[0]["inheritedMakeflags"] == "--jobserver-auth=3,4 -j8", "native boundary guards")
        if condition != "crash" or worker["id"] != 0:
            require(exits[0]["expectedTermination"] is True or (exits[0]["code"] == 0 and exits[0]["acknowledged"] is True), "unexpected worker exit")
    starts = [event for event in events if event["event"] == "start"]
    require(starts[0]["jobId"] == transport["jobId"] and starts[0]["entrypoint"] == "sby", "root identity")
    stdout, stderr = text("stdout.log"), text("stderr.log")
    require("FORBIDDEN_NATIVE_BOUNDARY:" not in stdout + stderr, "forbidden native call")
    names = evidence.files(label + "/output")
    require(names == set(files), "complete output inventory")
    for name, info in files.items():
        raw = evidence.read(label + "/output/" + name)
        require(type(info["bytes"]) is int and len(raw) == info["bytes"] and digest(raw) == info["sha256"], "artifact hash: " + name)
    waits = [event for event in events if event["event"] == "solver-stdin-wait"]
    sha = meta["probes"][solver]["sha256"]
    for event in waits:
        require(event["kind"] == "solver" and event["channel"] == "stdin" and event["index"] == 3 and event["sha256"] == sha, "real solver stdin boundary")
        require(any(start["worker"] == event["worker"] and start["sha256"] == sha for start in starts), "solver binary identity")
    sby_status = None
    if condition in NORMAL:
        fixture, sby_status, code = NORMAL[condition]
        require(transport["status"] == "exited" and transport.get("integrityVerified") is True and type(transport.get("exitCode")) is int and transport["exitCode"] == code, "ordinary SBY termination")
        require(names == SBY.artifact_names(fixture), "ordinary SBY artifact set")
        require(re.fullmatch(sby_status + r" [0-9]+ [0-9]+\n", text("output/result/status")), "SBY status file")
        require(re.search(r" DONE \(" + sby_status + ", rc=" + str(code) + r"\)\s*$", stdout), "SBY final result")
        require(stderr == "" and "Elapsed process time unavailable in the browser" in stdout and waits, "normal guarded runtime")
        environments = [event for event in events if event["event"] == "environment-after-run"]
        require(len(environments) == sum(worker["kind"] == "python" for worker in workers) and all(event["makeflags"] == "" for event in environments), "inherited jobserver cleared")
        require(transport["children"] and all(child["status"] == "exited" and child["integrityVerified"] is True for child in transport["children"]), "normal child transport")
        if solver in ["bitwuzla", "boolector"]:
            for child in transport["children"]:
                if child["args"][0] == "yosys-smtbmc":
                    SBY.SOLVERS.audit_children(child["children"], solver, sha, fixture, "induction" if "-i" in child["args"] else "bmc")
    else:
        expected = "runtime-error" if condition in RESTRICTIONS else {**FAULTS, **EXTRA_FAULTS}[condition]
        require(transport["status"] == expected and transport.get("integrityVerified") is not True and not files and "DONE (PASS," not in stdout, "failure cannot be a verified success")
        if condition in RESTRICTIONS:
            require(len(workers) == 1 and RESTRICTIONS[condition] in stderr, "option rejected before spawning")
        if condition in ["cancel", "timeout", "crash", "protocol"]:
            require(waits and any(start["entrypoint"] == "smtbmc" for start in starts), "active upstream SMTBMC and solver")
            require(any(child.get("role") == "tool" and child["args"][0] == "yosys-smtbmc" for child in transport["children"]), "SMTBMC child completion")
            if condition == "timeout":
                require(transport["elapsedMs"] >= meta["deadlineMs"], "root deadline actually elapsed")
            else:
                triggers = [event for event in events if event["event"] == "fault-trigger"]
                require(len(triggers) == 1 and triggers[0]["mode"] == condition and 0 in triggers[0]["activeWorkers"] and waits[0]["worker"] in triggers[0]["activeWorkers"] and triggers[0]["ms"] >= waits[0]["ms"], "live fault precondition")
            if condition == "crash":
                require(any(event["event"] == "root-crash" for event in events) and any(event["worker"] == 0 and event["event"] == "exit" and event["code"] == 17 and event["expectedTermination"] is False for event in events), "actual unexpected root exit")
        if condition == "corrupt-delta":
            changed = [event for event in events if event["event"] == "delta-corrupted"]
            require(len(changed) == 1 and changed[0]["bytes"] > 0 and changed[0]["beforeSha256"] != changed[0]["afterSha256"] and "Workspace delta hash mismatch:" in stderr, "real payload corruption rejection")
        if condition == "conflict-delta":
            concurrent = hashlib.sha256(b"concurrent root write\n").hexdigest()
            for name in ["delta-conflict", "conflict-root-preserved"]:
                require(any(event["event"] == name and event["sha256"] == concurrent for event in events), "root conflict was not preserved")
            require("Workspace delta conflict:" in stderr, "before-hash conflict rejection")
        if condition == "syntax-error":
            mutations = [event for event in events if event["event"] == "solver-syntax-input"]
            endings = [event for event in events if event["event"] == "solver-syntax-exit"]
            require(len(mutations) == len(endings) == 1, "single actual syntax mutation")
            mutation, ending = mutations[0], endings[0]
            before, after = (base64.b64decode(mutation[name], validate=True) for name in ["before", "after"])
            require(before and len(before) == len(after) == mutation["bytes"] and before != after and before[1:] == after[1:] and after[0] == mutation["firstByte"] == 63, "raw syntax bytes")
            require(digest(before) == mutation["beforeSha256"] and digest(after) == mutation["afterSha256"] and mutation["fd"] == 0 and mutation["sha256"] == sha, "syntax input integrity")
            require(ending["sha256"] == sha and ending["corrupted"] is True and ending["resultType"] == "exit" and type(ending["exitCode"]) is int and ending["exitCode"] == 1, "actual syntax rejection, not a trap")
            require(re.search(r"error|expected|invalid|parse", ending["output"], flags=re.I), "upstream parser diagnostic")
        if condition == "exit-code":
            changed = [event for event in events if event["event"] == "solver-exit-code"]
            require(len(changed) == 1 and changed[0]["sha256"] == sha and changed[0]["resultType"] == "exit", "actual solver exit mismatch")
            require(type(changed[0]["originalCode"]) is int and changed[0]["originalCode"] == (20 if solver == "boolector" else 0) and type(changed[0]["forcedCode"]) is int and changed[0]["forcedCode"] == 9, "explicit disallowed exit injection")
    return dict(zip(COLUMNS, [label, solver, transport["status"], transport.get("exitCode"), sby_status,
                             transport["elapsedMs"], len(files), len(workers), len(workers), len(waits), sha, None]))


def audit(directory, solvers=("yices2", "z3")):
    solvers = SBY.SOLVERS.select(solvers)
    evidence = Evidence(directory)
    meta, results = evidence.data("metadata.json"), evidence.data("results.json")
    require(meta["format"] == 1 and type(meta["preliminary"]) is bool and re.fullmatch(r"[a-f0-9]{40}", meta["commit"]), "measurement provenance")
    require(meta["preliminary"] or meta["worktree"] == "", "formal clean commit")
    require(meta["deadlineMs"] == 15000 and meta["cleanupDeadlineMs"] == 5000 and results["preliminary"] is meta["preliminary"], "fixed deadlines and mode")
    require(SNAPSHOTS <= set(meta["snapshots"]), "complete auditor and worker snapshots")
    require(meta["preliminary"] or "scripts/measure-formal-controls.py" in meta["snapshots"], "formal measurement snapshot")
    for name, sha in meta["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha, "snapshot hash: " + name)
    require(evidence.data("assets/manifest.json") == meta["sources"], "source manifest identity")
    assets = meta["sources"]["assets"]
    require(evidence.files("assets") == {"manifest.json"} | {asset["path"] for asset in assets}, "source closure")
    for asset in assets:
        raw = evidence.read("assets/" + asset["path"])
        require(len(raw) == asset["size"] and digest(raw) == asset["sha256"], "source asset hash")
    for name, key in [("yosys.wasm", "sha256"), ("yosys-share.tar", "shareSha256")]:
        require(digest(evidence.read("inputs/" + name)) == meta["yosys"][key], "Yosys binary identity")
    require(set(meta["probes"]) == set(solvers), "selected solver set")
    for solver, probe in meta["probes"].items():
        raw, binary = evidence.read("build/" + solver + ".json"), evidence.read("inputs/" + solver + ".wasm")
        build = SBY.strict_json(raw)
        require(digest(raw) == probe["metadataSha256"] and digest(binary) == probe["sha256"] == build["artifact"]["sha256"] and len(binary) == build["artifact"]["bytes"], "solver build and binary hash")
        require(build["status"] == "built" and build["worktree_status"] == "" and build["runtime"] == "wasi" and build["solver"] == solver, "successful pinned solver build")
    faults = [*FAULTS, *(EXTRA_FAULTS if set(solvers) <= {"bitwuzla", "boolector"} else [])]
    matrix = [(solver + "-" + condition, solver, condition) for solver in solvers for condition in [*NORMAL, *faults]]
    matrix.extend(("restriction-" + condition, solvers[0], condition) for condition in RESTRICTIONS)
    rows = [audit_case(evidence, meta, *condition) for condition in matrix]
    require(results["rows"] == rows, "all result columns rederived")
    for row in rows:
        require(evidence.data(row["condition"] + "/result.json") == row, "per-condition result columns")
    require(evidence.read("results.csv") == rows_csv(rows), "all CSV columns rederived")
    return {"status": "pass", "commit": meta["commit"], "preliminary": meta["preliminary"],
            "rows": len(rows), "columns": len(COLUMNS), "workers": sum(row["workers"] for row in rows),
            "files": sum(row["files"] for row in rows), "csvSha256": digest(evidence.read("results.csv"))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--solver", choices=SBY.SOLVERS.SOLVERS, action="append")
    args = parser.parse_args()
    print(json.dumps(audit(args.directory, args.solver if args.solver is not None else ("yices2", "z3")), sort_keys=True, allow_nan=False))
