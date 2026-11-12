#!/usr/bin/env python3
"""元VerilogのSMT再実行証拠を改変し、全列監査の拒否を保存する。"""

import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


SPEC = importlib.util.spec_from_file_location("negative_smt_replay_audit", Path(__file__).with_name("audit-smt-replay.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def changed_json(raw, modify):
    value = json.loads(raw)
    modify(value)
    return json.dumps(value, allow_nan=False).encode()


def changed_csv(raw, column):
    reader = csv.DictReader(io.StringIO(raw.decode()))
    rows = list(reader)
    rows[0][column] = "changed"
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=reader.fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode()


def mutations(solver):
    controls = []
    for column in AUDIT.COLUMNS:
        controls.extend([
            ("csv-" + column, "results.csv", lambda raw, column=column: changed_csv(raw, column)),
            ("json-" + column, "results.json", lambda raw, column=column: changed_json(raw, lambda value: value["rows"][0].update({column: "changed"}))),
        ])
    group = solver + "-depth-n/pyodide-formal_trace/"
    controls.extend([
        ("source", group + "files/top.v", lambda raw: raw + b"\n// changed\n"),
        ("model", group + "files/model.smt2", lambda raw: raw + b"\n; changed\n"),
        ("vcd", group + "files/trace.vcd", lambda raw: raw + b"#100000\n"),
        ("testbench", group + "files/trace_tb.v", lambda raw: raw + b"// changed\n"),
        ("capture-value", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["steps"][0]["values"][-1].update(bits="111"))),
        ("missing-sample", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["steps"].pop())),
        ("clock-edge", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["signals"][0].update(clock="negedge"))),
        ("replay", group + "replay.v", lambda raw: raw + b"// changed\n"),
        ("replay-plan", group + "plan.json", lambda raw: changed_json(raw, lambda value: value["ports"][-1]["values"].__setitem__(0, "111"))),
        ("replay-output", group + "replay-native/stdout.log", lambda raw: raw + b"FORMAL_REPLAY_CHECK 9\n"),
        ("replay-waveform", group + "replay-wasm/replay.vcd", lambda raw: raw.replace(b"#0", b"#1", 1)),
        ("replay-diagnostics", group + "replay-native/stderr.log", lambda raw: raw + b"unexpected warning\n"),
        ("replay-exit", group + "replay-wasm/execution.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("replay-verification", group + "replay-native/verification.json", lambda raw: changed_json(raw, lambda value: value.update(steps=0))),
        ("missing-waveform", group + "replay-native/replay.vcd", lambda raw: None),
        ("execution-status-type", group + "replay-wasm/execution.json", lambda raw: changed_json(raw, lambda value: value.update(status=False))),
        ("verification-step-type", f"{solver}-combinational/pyodide-formal_trace/replay-wasm/verification.json", lambda raw: changed_json(raw, lambda value: value.update(steps=True))),
        ("plan-step-type", f"{solver}-combinational/pyodide-formal_trace/plan.json", lambda raw: changed_json(raw, lambda value: value.update(steps=True))),
        ("process-code-type", f"{solver}-no-property/pyodide-formal_trace/process.json", lambda raw: changed_json(raw, lambda value: value.update(exitCode=False))),
        ("format-type", "metadata.json", lambda raw: changed_json(raw, lambda value: value.update(format=True))),
        ("diagnostic-time", group + "replay-wasm/stdout.log", lambda raw: re.sub(rb"(Time:\s*)\d+", rb"\g<1>999999", raw)),
        ("native-compile-exit", group + "replay-native/ivl.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("native-compile-warning", group + "replay-native/ivl.stderr", lambda raw: raw + b"unexpected warning\n"),
        ("native-run-output", group + "replay-native/vvp.stdout", lambda raw: raw + b"unexpected output\n"),
        ("unexpected-artifact", group + "files/unexpected", lambda raw: b"unexpected"),
        ("missing-row", "results.json", lambda raw: changed_json(raw, lambda value: value["rows"].pop())),
        ("duplicate-row", "results.json", lambda raw: changed_json(raw, lambda value: value["rows"].__setitem__(-1, value["rows"][0]))),
        ("duplicate-json-key", "results.json", lambda raw: b'{"a":1,"a":2}'),
        ("nonfinite", "results.json", lambda raw: b'{"a":NaN}'),
        ("unsafe-path", "metadata.json", lambda raw: changed_json(raw, lambda value: value["assets"]["assets"][0].update(path="../outside"))),
    ])
    for field, value in {"args": ["wrong"], "exitCode": 0 if solver == "boolector" else 9, "sha256": "0" * 64,
                         "status": "runtime-error", "integrityVerified": False, "stderrBytes": 1, "exitCodes": [False]}.items():
        controls.append(("child-" + field, group + "process.json", lambda raw, field=field, value=value:
                         changed_json(raw, lambda data: data["children"][-1].update({field: value}))))
    return controls


def run(source, out):
    source, out = Path(source).resolve(strict=True), Path(out).absolute()
    AUDIT.require(not out.exists() and not out.is_symlink() and not out.is_relative_to(source), "fresh external mutation directory")
    report = AUDIT.audit(source)
    out.mkdir()
    clone = out / "mutated-evidence"
    shutil.copytree(source, clone, copy_function=os.link)
    solver = AUDIT.Evidence(source).data("metadata.json")["solvers"][0]
    receipts = []
    for label, name, modify in mutations(solver):
        target = clone / name
        raw = target.read_bytes() if target.exists() else None
        changed = modify(raw)
        AUDIT.require(raw != changed, "ineffective mutation: " + label)
        try:
            target.unlink(missing_ok=True)
            if changed is not None:
                target.write_bytes(changed)
            command = [sys.executable, str(Path(__file__).with_name("audit-smt-replay.py")), str(clone)]
            if not report["preliminary"]:
                command.append("--formal")
            observed = subprocess.run(command, capture_output=True, timeout=60)
            (out / (label + ".stdout.log")).write_bytes(observed.stdout)
            (out / (label + ".stderr.log")).write_bytes(observed.stderr)
            AUDIT.require(observed.returncode != 0 and observed.stderr, "mutation accepted: " + label)
            receipts.append({"control": label, "exitCode": observed.returncode, "stdoutSha256": AUDIT.digest(observed.stdout), "stderrSha256": AUDIT.digest(observed.stderr)})
        finally:
            target.unlink(missing_ok=True)
            if raw is not None:
                target.write_bytes(raw)
    AUDIT.audit(clone, formal=not report["preliminary"])
    AUDIT.audit(source, formal=not report["preliminary"])
    result = {"status": "pass", "preliminary": report["preliminary"], "controls": receipts}
    (out / "results.json").write_text(json.dumps(result, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.source, args.out)
    print(json.dumps({"status": result["status"], "controls": len(result["controls"]), "preliminary": result["preliminary"]}))
