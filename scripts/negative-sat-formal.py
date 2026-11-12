#!/usr/bin/env python3
"""Yosys SAT 形式検証の正式証拠を改変し、監査器がすべて拒否することを保存する。"""

import argparse
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("negative_sat_formal_measure", HERE / "measure-sat-formal.py")
MEASURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEASURE)
AUDIT = MEASURE.AUDIT


def changed_json(raw, modify):
    value = json.loads(raw)
    modify(value)
    return json.dumps(value, allow_nan=False).encode()


def changed_csv(raw, column):
    reader = csv.DictReader(io.StringIO(raw.decode()))
    rows = list(reader)
    rows[0][column] = "changed"
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=reader.fieldnames, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode()


def row_update(index, field, value):
    return lambda raw: changed_json(raw, lambda data: data["rows"][index].update({field: value}))


def mutations():
    sample = "run-3/verdict/"
    errors = "run-2/error/"
    controls = [("csv-" + column, "sat-formal.csv", lambda raw, column=column: changed_csv(raw, column)) for column in MEASURE.COLUMNS]
    for column in AUDIT.COLUMNS:
        value = "changed" if column != "phases" else []
        controls.append(("row-" + column, sample + "results.json", row_update(1, column, value)))
    for column in AUDIT.REPLAY_COLUMNS:
        controls.append(("replay-" + column, sample + "results.json",
                         lambda raw, column=column: changed_json(raw, lambda data: data["replays"][0].update({column: "changed"}))))
    controls.extend([
        ("timing-zero", sample + "results.json", row_update(0, "elapsedMs", 0)),
        ("timing-float", sample + "results.json", row_update(0, "elapsedMs", 1.5)),
        ("memory-unaligned", sample + "results.json", row_update(1, "wasmMemoryBytes", 65537)),
        ("native-memory", sample + "results.json", row_update(0, "wasmMemoryBytes", 65536)),
        ("exit-type", sample + "results.json", row_update(0, "exitCode", False)),
        ("depth-type", sample + "results.json", row_update(0, "depth", True)),
        ("missing-row", sample + "results.json", lambda raw: changed_json(raw, lambda data: data["rows"].pop())),
        ("duplicate-row", sample + "results.json", lambda raw: changed_json(raw, lambda data: data["rows"].__setitem__(1, data["rows"][0]))),
        ("swapped-order", sample + "results.json", lambda raw: changed_json(raw, lambda data: data["rows"].__setitem__(slice(0, 2), data["rows"][1::-1]))),
        ("missing-replay", sample + "results.json", lambda raw: changed_json(raw, lambda data: data["replays"].pop())),
        ("hidden-failure", sample + "results.json", lambda raw: changed_json(raw, lambda data: data["failures"].append({"case": "identity"}))),
        ("verdict-flip", sample + "identity/native-proof.stdout", lambda raw: raw.replace(b"no model found: SUCCESS!", b"model found: FAIL!")),
        ("double-success", sample + "depth3/wasm-proof.stdout", lambda raw: raw + b"SAT proof finished - no model found: SUCCESS!\n"),
        ("induction-missing", sample + "induction/native-proof.stdout", lambda raw: raw.replace(b"Induction step proven: SUCCESS!", b"Induction step skipped")),
        ("assumption-flip", sample + "contradictory-assumes/wasm-presat.stdout", lambda raw: raw.replace(b"no model found.", b"model found:")),
        ("missing-proof-log", sample + "depth4/native-proof.stdout", lambda raw: None),
        ("missing-script", sample + "depth4/wasm-prepare.ys", lambda raw: None),
        ("log-change", sample + "depth5/wasm-prepare.stdout", lambda raw: raw + b"\n"),
        ("source-change", sample + "depth4/native/top.v", lambda raw: raw + b"\n// changed\n"),
        ("witness-change", sample + "depth4/wasm-replay/witness.json", lambda raw: changed_json(raw, lambda data: data["signal"].pop())),
        ("replay-change", sample + "depth4/wasm-replay/replay.v", lambda raw: raw + b"// changed\n"),
        ("replay-vcd", sample + "depth4/wasm-replay/wasm-replay.vcd", lambda raw: raw.replace(b"#0", b"#1", 1)),
        ("replay-vcd-date", sample + "depth4/wasm-replay/wasm-replay.vcd", lambda raw: raw + b"$date again $end\n"),
        ("replay-exit", sample + "depth4/native-replay/wasm-execution.json", lambda raw: changed_json(raw, lambda data: data.update(status=1))),
        ("replay-stderr", sample + "depth4/native-replay/wasm-execution.json", lambda raw: changed_json(raw, lambda data: data.update(stderr="warning"))),
        ("native-replay-stderr", sample + "depth5/wasm-replay/vvp.stderr", lambda raw: raw + b"unexpected warning\n"),
        ("replay-stdout", sample + "depth5/wasm-replay/vvp.stdout", lambda raw: raw + b"FORMAL_REPLAY_CHECK 9\n"),
        ("negative-unchanged", sample + "false-induction/native-replay/negative-witness.json",
         lambda raw: (Path(CLONE) / sample / "false-induction/native-replay/witness.json").read_bytes()),
        ("negative-status-type", sample + "depth5/native-replay/negative-result.json", lambda raw: changed_json(raw, lambda data: data.update(status="0"))),
        ("unexpected-case-entry", sample + "unexpected", lambda raw: b"unexpected"),
        ("unexpected-sample-entry", "run-3/unexpected", lambda raw: b"unexpected"),
        ("unexpected-root-entry", "unexpected", lambda raw: b"unexpected"),
        ("error-message", errors + "results.json", lambda raw: changed_json(raw, lambda data: data["failures"][0].update(message="changed"))),
        ("error-phase", errors + "results.json", lambda raw: changed_json(raw, lambda data: data["failures"][2].update(phase="proof"))),
        ("error-as-pass", errors + "results.json", row_update(0, "actual", "bounded-safe")),
        ("error-exit", errors + "results.json", row_update(6, "exitCode", 0)),
        ("error-sat-ran", errors + "zero-properties/native-presat.stdout", lambda raw: b"SAT solving finished - model found:\n"),
        ("error-replay", errors + "results.json", lambda raw: changed_json(raw, lambda data: data["replays"].append({}))),
        ("metadata-commit", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data.update(commit="0" * 40))),
        ("metadata-worktree", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data.update(worktree=" M x"))),
        ("metadata-order", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data.update(order="wasm-first"))),
        ("metadata-binary", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data["binaries"]["yosys-wasm"].update(sha256="0" * 64))),
        ("metadata-host", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data["host"].update(arch="changed"))),
        ("metadata-format-type", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data.update(format=True))),
        ("metadata-cases", sample + "metadata.json", lambda raw: changed_json(raw, lambda data: data["cases"].pop())),
        ("plan-schedule", "plan.json", lambda raw: changed_json(raw, lambda data: data["schedule"].pop())),
        ("plan-worktree", "plan.json", lambda raw: changed_json(raw, lambda data: data.update(worktree=" M x"))),
        ("snapshot-change", "snapshots/scripts/audit-sat-formal.py", lambda raw: raw + b"\n# changed\n"),
        ("commands-change", "commands.json", lambda raw: changed_json(raw, lambda data: data[0].__setitem__(5, "wasm-first"))),
        ("summary-change", "summary.json", lambda raw: changed_json(raw, lambda data: data.update(rows=0))),
        ("audits-change", "audits.json", lambda raw: changed_json(raw, lambda data: data[0].update(rows=0))),
        ("duplicate-json-key", sample + "results.json", lambda raw: b'{"a":1,"a":2}'),
        ("nonfinite", sample + "results.json", lambda raw: b'{"a":NaN}'),
    ])
    return controls


CLONE = None


def run(source, out):
    global CLONE
    source, out = Path(source).resolve(strict=True), Path(out).absolute()
    AUDIT.require(not out.exists() and not out.is_symlink() and not out.is_relative_to(source), "fresh external mutation directory")
    MEASURE.audit(source)
    out.mkdir(parents=True)
    clone = out / "mutated-evidence"
    shutil.copytree(source, clone, copy_function=os.link)
    CLONE = clone
    receipts = []
    for label, name, modify in mutations():
        target = clone / name
        raw = target.read_bytes() if target.exists() else None
        changed = modify(raw)
        AUDIT.require(raw != changed, "ineffective mutation: " + label)
        try:
            target.unlink(missing_ok=True)
            if changed is not None:
                target.write_bytes(changed)
            command = [sys.executable, str(HERE / "measure-sat-formal.py"), "--audit-only", "--out", str(clone)]
            observed = subprocess.run(command, capture_output=True, timeout=300)
            (out / (label + ".stdout.log")).write_bytes(observed.stdout)
            (out / (label + ".stderr.log")).write_bytes(observed.stderr)
            AUDIT.require(observed.returncode != 0 and observed.stderr, "mutation accepted: " + label)
            receipts.append({"control": label, "exitCode": observed.returncode,
                             "stdoutSha256": AUDIT.digest(observed.stdout), "stderrSha256": AUDIT.digest(observed.stderr)})
        finally:
            target.unlink(missing_ok=True)
            if raw is not None:
                target.write_bytes(raw)
    MEASURE.audit(clone)
    MEASURE.audit(source)
    result = {"status": "pass", "controls": receipts}
    (out / "results.json").write_text(json.dumps(result, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.source, args.out)
    print(json.dumps({"status": result["status"], "controls": len(result["controls"])}))
