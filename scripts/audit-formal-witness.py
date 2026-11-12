#!/usr/bin/env python3
"""Audit witness format boundaries without treating fixture traces as proofs."""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import re


SPEC = importlib.util.spec_from_file_location("control_audit", Path(__file__).with_name("audit-formal-controls.py"))
CONTROL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTROL)
require, digest, Evidence = CONTROL.require, CONTROL.digest, CONTROL.Evidence
COLUMNS = "conversion status exitCode bytes sha256 mapSha256 elapsedMs".split()
CASES = [("aiw2yw", "trace.aiw", "aiger-map.json", "aiger.yw"), ("wit2yw", "trace.wit", "btor-map.json", "btor.yw")]


def audit(directory):
    evidence = Evidence(directory)
    meta = evidence.data("metadata.json")
    require(meta["format"] == 1 and meta["purpose"] == "witness-format-boundary-only-not-an-SBY-proof" and type(meta["preliminary"]) is bool, "fixture identity")
    require(re.fullmatch(r"[a-f0-9]{40}", meta["commit"]) and (meta["preliminary"] or meta["worktree"] == ""), "witness revision")
    required = {"scripts/probe-formal-witness.mjs", "scripts/audit-formal-witness.py", "tests/synth/formal-witness-boundary.py",
                "tests/synth/formal-control-workers.mjs", "tests/synth/formal-controlled-python-worker.mjs"}
    require(required <= set(meta["snapshots"]), "witness snapshots missing")
    for name, sha in meta["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha, "witness snapshot hash")
    original = evidence.data("original-assets/manifest.json")
    names = {asset["path"] for asset in original["assets"]}
    require({"sby.py", "witness.py", "ywio.py", "formal_process.py"} <= names and len(names) == len(original["assets"]), "source closure")
    require(evidence.files("original-assets") == names | {"manifest.json"}, "complete original source inventory")
    for asset in original["assets"]:
        raw = evidence.read("original-assets/" + asset["path"])
        require(digest(raw) == asset["sha256"] and len(raw) == asset["size"], "upstream source hash")
    runtime = evidence.data("runtime-manifest.json")
    fixture = evidence.read("snapshots/tests/synth/formal-witness-boundary.py")
    expected = json.loads(json.dumps(original))
    for asset in expected["assets"]:
        if asset["path"] == "sby.py":
            asset.update(size=len(fixture), sha256=digest(fixture))
    expected["test_fixture"] = "Root SbyPopen boundary fixture, not upstream SBY"
    require(runtime == expected, "only root fixture may replace SBY; witness code unchanged")
    require(digest(evidence.read("inputs/yosys")) == meta["yosys"]["sha256"] and original["pins"]["yosys"][:9] in meta["yosys"]["version"], "native map generator")
    for name in ["aiger", "btor"]:
        process = evidence.data(f"native/{name}-process.json")
        require(type(process["exitCode"]) is int and process["exitCode"] == 0 and process["signal"] is None and process["error"] is None, "native map process")
        require(process["args"] == ["-Q", "-T", "-s", name + ".ys"] and process["scriptSha256"] == digest(evidence.read("native/" + name + ".ys")), "map command identity")
        require(evidence.read(f"native/{name}-stderr.log") == b"", "native map stderr")
    transport = evidence.data("transport.json")
    require(transport["status"] == "exited" and transport["integrityVerified"] is True and type(transport["exitCode"]) is int and transport["exitCode"] == 0 and CONTROL.finite(transport["elapsedMs"]), "root witness completion")
    require(len(transport["children"]) == 2, "two real witness children")
    expected_names = {"witness/" + name for _, trace, mapping, output in CASES for name in [trace, mapping, output]}
    require(evidence.files("output") == expected_names, "complete witness output set")
    rows, logs = [], []
    for child, (conversion, trace, mapping, output) in zip(transport["children"], CASES):
        args = ["yosys-witness", conversion, trace, mapping, output]
        require(child["role"] == "tool" and child["args"] == args and child["status"] == "exited" and child["integrityVerified"] is True and type(child["exitCode"]) is int and child["exitCode"] == 0 and child["children"] == [], "real SbyPopen command boundary")
        native = evidence.data("native/" + conversion + "-process.json")
        require(native["args"][1:] == args[1:] and Path(native["args"][0]).name == "witness.py" and type(native["exitCode"]) is int and native["exitCode"] == 0 and native["signal"] is None and native["error"] is None, "native converter completion")
        for name in [trace, mapping, output]:
            require(evidence.read("output/witness/" + name) == evidence.read("native/" + name), "transport/native byte mismatch: " + name)
        raw = evidence.read("native/" + output)
        yw = CONTROL.SBY.strict_json(raw)
        require(yw["format"] == "Yosys Witness Trace" and yw["generator"] == "yosys-witness " + conversion and len(yw["steps"]) == 2, "converted format fixture")
        require(evidence.read("native/" + conversion + "-stderr.log") == b"", "native witness stderr")
        log = evidence.read("native/" + conversion + "-stdout.log")
        require(log.endswith(b"Converted 2 time steps.\n") and b"Warning:" not in log, "complete conversion log")
        logs.append(log)
        rows.append(dict(zip(COLUMNS, [conversion, "exited", 0, len(raw), digest(raw), digest(evidence.read("native/" + mapping)), transport["elapsedMs"]])))
    require(evidence.read("stdout.log") == b"".join(logs) and evidence.read("stderr.log") == b"", "stdout/stderr transport equality")
    events, workers = evidence.data("events.json"), evidence.data("workers.json")
    require(len(workers) == 3 and {worker["id"] for worker in workers} == {0, 1, 2} and sum(worker["root"] is True for worker in workers) == 1, "three physical workers")
    for worker in workers:
        require(worker["kind"] == "python" and worker["exited"] is True, "witness worker remains active")
        seen = [event for event in events if event["worker"] == worker["id"]]
        starts = [event for event in seen if event["event"] == "start"]
        exits = [event for event in seen if event["event"] == "exit"]
        require(len(starts) == len(exits) == 1 and starts[0]["entrypoint"] == ("sby" if worker["root"] else "witness") and starts[0]["ms"] < exits[0]["ms"], "witness lifecycle")
        require(exits[0]["acknowledged"] is True and (exits[0]["expectedTermination"] is True or exits[0]["code"] == 0), "witness physical termination")
        require(any(event["event"] == "native-guards-installed" and event["resourceAvailable"] is False for event in seen), "witness native traps")
    require(evidence.data("results.json") == {"preliminary": meta["preliminary"], "rows": rows}, "witness result columns rederived")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writerow(COLUMNS)
    writer.writerows([row[key] for key in COLUMNS] for row in rows)
    require(evidence.read("results.csv") == stream.getvalue().encode(), "all witness CSV columns rederived")
    return {"status": "pass", "commit": meta["commit"], "preliminary": meta["preliminary"], "rows": 2, "columns": len(COLUMNS),
            "workers": 3, "files": len(expected_names), "csvSha256": digest(evidence.read("results.csv")), "outputs": {row["conversion"]: row["sha256"] for row in rows}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    print(json.dumps(audit(parser.parse_args().directory), sort_keys=True))
