#!/usr/bin/env python3
"""SMT記録の実証拠を一箇所ずつ変え、独立監査の拒否を保存する。"""

import argparse
import csv
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys


SPEC = importlib.util.spec_from_file_location("negative_trace_audit", Path(__file__).with_name("audit-formal-trace.py"))
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def json_change(raw, modify):
    value = json.loads(raw)
    modify(value)
    return json.dumps(value, allow_nan=False).encode()


def csv_change(raw, column):
    reader = csv.DictReader(io.StringIO(raw.decode()))
    rows = list(reader)
    rows[0][column] = "changed"
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=reader.fieldnames, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue().encode()


def mutations(solver):
    result = []
    for column in AUDIT.COLUMNS:
        result.extend([
            ("csv-" + column, "results.csv", lambda raw, column=column: csv_change(raw, column)),
            ("json-" + column, "results.json", lambda raw, column=column: json_change(raw, lambda value: value["rows"][0].update({column: "changed"}))),
        ])
    group = solver + "-bmc-violation-bmc/pyodide-formal_trace/"
    for field, value in {"args": ["wrong"], "sha256": "0" * 64, "exitCode": 0 if solver == "boolector" else 9,
                         "exitCodes": [False], "status": "runtime-error", "integrityVerified": False,
                         "error": "changed", "jobId": "", "processId": "", "stderrBytes": 1}.items():
        result.append(("child-" + field, group + "process.json", lambda raw, field=field, value=value:
                       json_change(raw, lambda data: data["children"][-1].update({field: value}))))
    result.extend([
        ("transport-integrity", group + "process.json", lambda raw: json_change(raw, lambda value: value.update(integrityVerified=False))),
        ("duplicate-child", group + "process.json", lambda raw: json_change(raw, lambda value: value["children"].append(value["children"][-1]))),
        ("missing-row", "results.json", lambda raw: json_change(raw, lambda value: value["rows"].pop())),
        ("duplicate-row", "results.json", lambda raw: json_change(raw, lambda value: value["rows"].__setitem__(-1, value["rows"][0]))),
        ("duplicate-key", "results.json", lambda raw: b'{"duplicate":1,"duplicate":2}'),
        ("nonfinite", "results.json", lambda raw: b'{"n":NaN}'),
        ("overflow-number", "results.json", lambda raw: b'{"n":1e999}'),
        ("unsafe-asset", "metadata.json", lambda raw: json_change(raw, lambda value: value["sources"]["assets"][0].update(path="../outside"))),
        ("changed-vcd", group + "files/trace.vcd", lambda raw: raw + b"changed\n"),
        ("missing-vcd", group + "files/trace.vcd", lambda raw: None),
        ("unexpected-artifact", group + "files/unexpected", lambda raw: b"unexpected"),
        ("changed-captured-value", group + "files/formal-trace.json", lambda raw: json_change(raw, lambda value:
            value["traces"][0]["steps"][0]["values"][-1].update(bits="111"))),
    ])
    if solver == "bitwuzla":
        result.append(("help-versus-smt", group + "process.json", lambda raw: json_change(raw, lambda value: value["children"].reverse())))
    if solver == "boolector":
        group = solver + "-bmc-prefix-bmc/pyodide-formal_trace/"
        result.append(("unsat-code-20-preserved", group + "process.json", lambda raw: json_change(raw, lambda value: value["children"][-1].update(exitCode=0))))
    return result


def run(source, out, solvers):
    source, out = Path(source).resolve(strict=True), Path(out).absolute()
    AUDIT.require(not out.exists() and not out.is_symlink() and not out.is_relative_to(source), "fresh external negative evidence directory required")
    AUDIT.audit(source, solvers)
    out.mkdir()
    clone = out / "mutated-evidence"
    shutil.copytree(source, clone)
    receipts = []
    for label, name, modify in mutations(solvers[0]):
        target = clone / name
        raw = target.read_bytes() if target.exists() else None
        changed = modify(raw)
        AUDIT.require(raw != changed, "ineffective mutation: " + label)
        try:
            if changed is None:
                target.unlink()
            else:
                target.write_bytes(changed)
            command = [sys.executable, str(Path(__file__).with_name("audit-formal-trace.py")), str(clone)]
            for solver in solvers:
                command.extend(["--solver", solver])
            observed = subprocess.run(command, capture_output=True, timeout=60)
            (out / (label + ".stdout.log")).write_bytes(observed.stdout)
            (out / (label + ".stderr.log")).write_bytes(observed.stderr)
            AUDIT.require(observed.returncode != 0 and observed.stderr, "mutation was accepted: " + label)
            receipts.append({"control": label, "exitCode": observed.returncode, "stdoutSha256": AUDIT.digest(observed.stdout), "stderrSha256": AUDIT.digest(observed.stderr)})
        finally:
            if raw is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(raw)
    AUDIT.audit(clone, solvers)
    report = {"status": "pass", "controls": receipts}
    (out / "results.json").write_text(json.dumps(report, sort_keys=True) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--solver", action="append", choices=AUDIT.SOLVERS.SOLVERS)
    args = parser.parse_args()
    report = run(args.source, args.out, AUDIT.SOLVERS.select(args.solver if args.solver is not None else ("yices2", "z3")))
    print(json.dumps({"status": report["status"], "controls": len(report["controls"])}))
