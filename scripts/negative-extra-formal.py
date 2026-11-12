#!/usr/bin/env python3
"""追加solverの実証拠を変更し、原本を保持して拒否を検査する。"""

import argparse
import csv
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, allow_nan=False) + "\n").encode()


def changed_json(raw, modify):
    value = json.loads(raw)
    modify(value)
    return json_bytes(value)


def changed_csv(raw, key, value):
    source = csv.DictReader(io.StringIO(raw.decode()))
    rows = list(source)
    if not rows or key not in source.fieldnames:
        raise ValueError("missing control column")
    rows[0][key] = value
    result = io.StringIO(newline="")
    writer = csv.DictWriter(result, fieldnames=source.fieldnames, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return result.getvalue().encode()


def mutations():
    result = []
    for solver in ["bitwuzla", "boolector"]:
        prefix = "aa-1/" + solver + "/"
        artifact = prefix + "sby/" + solver + "-bmc-violation/pyodide/result/engine_0/trace.vcd"
        result.extend([
            (solver + "-artifact", artifact, lambda raw: raw + b"tampered witness\n"),
            (solver + "-solver-binary", prefix + "controls/inputs/" + solver + ".wasm", lambda raw: bytes([raw[0] ^ 1]) + raw[1:]),
            (solver + "-solver-hash", prefix + "controls/metadata.json", lambda raw, solver=solver: changed_json(raw, lambda value: value["probes"][solver].update(sha256="0" * 64))),
            (solver + "-transport-integrity", prefix + "controls/" + solver + "-bounded-pass/transport.json", lambda raw: changed_json(raw, lambda value: value.update(integrityVerified=False))),
            (solver + "-missing-artifact", artifact, lambda raw: None),
            (solver + "-extra-artifact", prefix + "controls/" + solver + "-bounded-pass/output/unexpected", lambda raw: b"unexpected artifact\n"),
        ])
    for name in ["smtbmc", "sby", "controls"]:
        result.extend([
            (name + "-csv-status", name + ".csv", lambda raw: changed_csv(raw, "status", "FORGED_PASS")),
            (name + "-csv-error", name + ".csv", lambda raw: changed_csv(raw, "error", "altered error")),
        ])
    result.extend([
        ("captured-auditor", "snapshots/scripts/formal-solver-audit.py", lambda raw: raw + b"\n# changed auditor\n"),
        ("saved-summary", "summary.json", lambda raw: changed_json(raw, lambda value: value.update(status="fail"))),
    ])
    return result


def atomic_bytes(path, raw):
    temporary = path.with_name(path.name + ".negative-writing")
    with temporary.open("xb") as stream:
        stream.write(raw)
    temporary.replace(path)


def clone_file(source, target):
    if Path(source).is_symlink():
        return shutil.copy2(Path(source).resolve(strict=True), target)
    os.link(source, target)
    return target


def audit(runner, evidence, out, label, rejected):
    command = [sys.executable, str(runner), "--audit-only", "--out", str(evidence)]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    (out / (label + ".stdout.log")).write_bytes(result.stdout)
    (out / (label + ".stderr.log")).write_bytes(result.stderr)
    if (result.returncode != 0) != rejected:
        raise ValueError("unexpected auditor verdict: " + label)
    if rejected and not result.stderr:
        raise ValueError("missing rejection diagnostic: " + label)
    return {"command": command, "exitCode": result.returncode, "stdoutSha256": digest(result.stdout), "stderrSha256": digest(result.stderr)}


def run(campaign, runner, out):
    campaign, runner, out = Path(campaign).resolve(strict=True), Path(runner).resolve(strict=True), Path(out)
    if out.exists() or out.is_symlink():
        raise ValueError("refuse to overwrite negative evidence")
    if out.resolve().is_relative_to(campaign):
        raise ValueError("negative evidence must be outside the source")
    out.mkdir()
    out = out.resolve(strict=True)
    seed = out / "mutated-evidence"
    shutil.copytree(campaign, seed, copy_function=clone_file)
    pristine = audit(runner, seed, out, "baseline", False)
    receipts = []
    snapshot = Path(__file__).read_bytes()
    (out / "negative-extra-formal.py").write_bytes(snapshot)
    for label, name, modify in mutations():
        target = seed / name
        original = target.read_bytes() if target.exists() else None
        changed = modify(original)
        if original == changed:
            raise ValueError("ineffective mutation: " + label)
        try:
            if changed is None:
                target.unlink()
            else:
                atomic_bytes(target, changed)
            observed = audit(runner, seed, out, label, True)
        finally:
            if original is None:
                target.unlink(missing_ok=True)
            else:
                atomic_bytes(target, original)
        if (target.read_bytes() if target.exists() else None) != original:
            raise ValueError("mutation restore mismatch: " + label)
        receipts.append({"condition": label, "path": name, "beforeSha256": digest(original) if original is not None else None,
                         "afterSha256": digest(changed) if changed is not None else None, "status": "rejected", **observed})
        (out / "partial.json").write_bytes(json_bytes(receipts))
    restored = audit(runner, seed, out, "restored-baseline", False)
    summary = {"status": "pass", "scriptSha256": digest(snapshot), "auditorSha256": digest(runner.read_bytes()),
               "campaignSummarySha256": digest((campaign / "summary.json").read_bytes()), "conditions": receipts,
               "baseline": pristine, "restored": restored}
    (out / "summary.json").write_bytes(json_bytes(summary))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--runner", type=Path, default=Path(__file__).with_name("measure-extra-formal.py"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run(args.campaign, args.runner, args.out), sort_keys=True))
