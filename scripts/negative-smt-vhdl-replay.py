#!/usr/bin/env python3
"""元VHDL/PSLと下位化VerilogのSMT再実行証拠を改変し、全列監査の拒否を保存する。"""

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


SPEC = importlib.util.spec_from_file_location("negative_smt_vhdl_replay_audit", Path(__file__).with_name("audit-smt-vhdl-replay.py"))
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


def replaced(pattern, replacement):
    def modify(raw):
        changed = re.sub(pattern, replacement, raw, count=1, flags=re.M)
        AUDIT.require(changed != raw, "mutation pattern not found: " + pattern.decode())
        return changed
    return modify


def children(group, solver):
    controls = []
    for field, value in {"args": ["wrong"], "exitCode": 0 if solver == "boolector" else 9, "sha256": "0" * 64,
                         "status": "runtime-error", "integrityVerified": False, "stderrBytes": 1, "exitCodes": [False]}.items():
        controls.append(("child-" + field, group + "process.json", lambda raw, field=field, value=value:
                         changed_json(raw, lambda data: data["children"][-1].update({field: value}))))
    return controls


def replay_controls(solver):
    group, psl = solver + "-depth-n/pyodide-formal_trace/", solver + "-psl/native-formal_trace/"
    lowered, vhdl = group + "replay-lowered-native/", group + "replay-vhdl/"
    return [
        ("source", group + "files/top.v", lambda raw: raw + b"\n// changed\n"),
        ("model", group + "files/model.smt2", lambda raw: raw + b"\n; changed\n"),
        ("vcd", group + "files/trace.vcd", lambda raw: raw + b"#100000\n"),
        ("testbench", group + "files/trace_tb.v", lambda raw: raw + b"// changed\n"),
        ("capture-value", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["steps"][0]["values"][-1].update(bits="111"))),
        ("missing-sample", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["steps"].pop())),
        ("clock-edge", group + "files/formal-trace.json", lambda raw: changed_json(raw, lambda value: value["traces"][0]["signals"][0].update(clock="negedge"))),
        ("replay", group + "replay.v", lambda raw: raw + b"// changed\n"),
        ("replay-plan", group + "plan.json", lambda raw: changed_json(raw, lambda value: value["ports"][-1]["values"].__setitem__(0, "111"))),
        ("lowered-mapping", group + "lowered-plan.json", lambda raw: changed_json(raw, lambda value: value["mappings"][0].update(line=value["mappings"][0]["line"] + 1))),
        ("lowered-omitted-cover", group + "lowered-plan.json", lambda raw: changed_json(raw, lambda value: value["omittedCovers"].append({"id": "x", "kind": "cover", "source": "top.vhd:1.1-1.1"}))),
        ("lowered-output", lowered + "stdout.log", lambda raw: raw + b"FORMAL_REPLAY_CHECK 9\n"),
        ("lowered-waveform", group + "replay-lowered-wasm/replay.vcd", lambda raw: raw.replace(b"#0", b"#1", 1)),
        ("lowered-diagnostics", lowered + "stderr.log", lambda raw: raw + b"unexpected warning\n"),
        ("lowered-exit", group + "replay-lowered-wasm/execution.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("lowered-verification", lowered + "verification.json", lambda raw: changed_json(raw, lambda value: value.update(steps=0))),
        ("lowered-missing-waveform", lowered + "replay.vcd", lambda raw: None),
        ("lowered-status-type", group + "replay-lowered-wasm/execution.json", lambda raw: changed_json(raw, lambda value: value.update(status=False))),
        ("lowered-diagnostic-time", group + "replay-lowered-wasm/stdout.log", replaced(rb"(Time:\s*)\d+", rb"\g<1>999999")),
        ("lowered-diagnostic-line", group + "replay-lowered-wasm/stdout.log", replaced(rb"^(ERROR: (?:work/)?[^:]+:)\d+", rb"\g<1>1")),
        ("native-compile-exit", lowered + "ivl.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("native-compile-warning", lowered + "ivl.stderr", lambda raw: raw + b"unexpected warning\n"),
        ("native-run-output", lowered + "vvp.stdout", lambda raw: raw + b"unexpected output\n"),
        ("native-executed-design", lowered + "work/top.v", lambda raw: raw + b"// changed\n"),
        ("ghdl-plan", group + "ghdl-plan.json", lambda raw: changed_json(raw, lambda value: value["markerTimesNs"].__setitem__(0, 1))),
        ("ghdl-input", group + "ghdl-replay.txt", lambda raw: raw.replace(b"STEP 1", b"STEP 2", 1)),
        ("vhdl-source", vhdl + "top.vhd", lambda raw: raw + b"-- changed\n"),
        ("vhdl-input", vhdl + "formal-ghdl-input.txt", lambda raw: raw + b"STEP 9\n"),
        ("vhdl-plugin", vhdl + "replay.vpi", lambda raw: raw + b"\0"),
        ("vhdl-analyze-warning", vhdl + "analyze.stderr", lambda raw: raw + b"warning\n"),
        ("vhdl-run-args", vhdl + "run.json", lambda raw: changed_json(raw, lambda value: value["args"].remove("--assert-level=none"))),
        ("vhdl-run-exit", vhdl + "run.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("vhdl-execution", vhdl + "execution.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("vhdl-stderr", vhdl + "run.stderr", lambda raw: raw + b"unexpected warning\n"),
        ("vhdl-marker", vhdl + "run.stdout", replaced(rb"^FORMAL_GHDL_CHECK 1\n", b"")),
        ("vhdl-diagnostic-time", vhdl + "run.stdout", replaced(rb":@\d+(fs|ps|ns)", rb":@999999\1")),
        ("vhdl-diagnostic-line", vhdl + "run.stdout", replaced(rb"^top\.vhd:\d+", b"top.vhd:1")),
        ("vhdl-diagnostic-instance", vhdl + "run.stdout", replaced(rb"^  instance: /top\S*", b"  instance: /other")),
        ("vhdl-missing-failure", vhdl + "run.stdout", replaced(rb"^top\.vhd:[^\n]*\n  instance:[^\n]*\n(?:  from:[^\n]*\n)?", b"")),
        ("vhdl-waveform-value", vhdl + "formal-ghdl.vcd", replaced(rb"\nb0001 (\S)", rb"\nb0010 \1")),
        ("vhdl-waveform-scope", vhdl + "formal-ghdl.vcd", replaced(rb"\$scope module top \$end", b"$scope module other $end")),
        ("vhdl-missing-waveform", vhdl + "formal-ghdl.vcd", lambda raw: None),
        ("vhdl-verification", vhdl + "verification.json", lambda raw: changed_json(raw, lambda value: value["failures"][0].update(step=1))),
        ("vhdl-unexpected-artifact", vhdl + "unexpected", lambda raw: b"unexpected"),
        ("psl-summary", psl + "replay-vhdl/psl-report.json", lambda raw: changed_json(raw, lambda value: value["summary"].update({"assert-pass": 1}))),
        ("psl-count", psl + "replay-vhdl/psl-report.json", lambda raw: changed_json(raw, lambda value: value["details"][0].update({"finished-count": 2}))),
        ("psl-status", psl + "replay-vhdl/psl-report.json", lambda raw: changed_json(raw, lambda value: value["details"][0].update(status="passed"))),
        ("psl-missing-report", psl + "replay-vhdl/psl-report.json", lambda raw: None),
        ("psl-flag", psl + "replay-vhdl/run.json", lambda raw: changed_json(raw, lambda value: value["args"].remove("-fpsl"))),
        ("vhdl-reject-accepted", f"{solver}-memory/native-formal_trace/replay-vhdl/verification.json",
         lambda raw: changed_json(raw, lambda value: value.update(status="verified", reason=None))),
        ("lowered-vhdl", "lowered/depth-n/top.vhd", lambda raw: raw + b"-- changed\n"),
        ("lowered-verilog", "lowered/depth-n/top.v", lambda raw: raw + b"// changed\n"),
        ("lowered-wasm", "lowered/depth-n/wasm.v", lambda raw: raw + b"// changed\n"),
        ("lowered-warning", "lowered/depth-n/lower.stderr", lambda raw: raw + b"warning\n"),
        ("inventory", "depth-n-inventory/wasm.json", lambda raw: changed_json(raw, lambda value: value["modules"]["top"]["ports"].pop(next(iter(value["modules"]["top"]["ports"]))))),
        ("inventory-script", "depth-n-inventory/native-inventory.ys", lambda raw: raw.replace(b" -icells", b"", 1)),
        ("emit", "depth-n-emit/wasm.v", lambda raw: raw + b"// changed\n"),
        ("emit-inventory", "depth-n-emit/native.json", lambda raw: changed_json(raw, lambda value: value["modules"]["top"]["cells"].clear())),
        ("emit-script", "depth-n-emit/native-emit.ys", lambda raw: raw.replace(b"chformal -cover -remove; ", b"", 1)),
        ("rejection-reason", f"{solver}-arbitrary-initial/native-formal_trace/rejection.json", lambda raw: changed_json(raw, lambda value: value.update(reason="changed"))),
        ("plugin", "ghdl-replay-plugin/replay.vpi", lambda raw: raw + b"\0"),
        ("plugin-build", "ghdl-replay-plugin/link.json", lambda raw: changed_json(raw, lambda value: value.update(status=1))),
        ("plan-step-type", f"{solver}-combinational/pyodide-formal_trace/plan.json", lambda raw: changed_json(raw, lambda value: value.update(steps=True))),
        ("verification-step-type", f"{solver}-combinational/pyodide-formal_trace/replay-lowered-wasm/verification.json", lambda raw: changed_json(raw, lambda value: value.update(steps=True))),
        ("unexpected-artifact", group + "files/unexpected", lambda raw: b"unexpected"),
        *children(group, solver),
    ]


def baseline_error_controls(solver):
    label = solver + "-depth-n/"
    return [
        ("upstream-exit", label + "upstream.json", lambda raw: changed_json(raw, lambda value: value.update(exitCode=1))),
        ("upstream-status", label + "upstream.json", lambda raw: changed_json(raw, lambda value: value.update(status="FAIL"))),
        ("upstream-source", label + "baseline/top.vhd", lambda raw: raw + b"-- changed\n"),
        ("upstream-lowered", label + "baseline/top.v", lambda raw: raw + b"// changed\n"),
        ("upstream-traceback", label + "baseline/result/engine_0/logfile.txt", lambda raw: raw.replace(b"Traceback (most recent call last):", b"changed", 1)),
        ("upstream-done", label + "baseline/result/logfile.txt", lambda raw: raw.replace(b"DONE (ERROR, rc=16)", b"DONE (FAIL, rc=2)", 1)),
        ("upstream-missing-log", label + "baseline/result/logfile.txt", lambda raw: None),
        ("lowered-vhdl", "lowered/depth-n-minus-1/top.vhd", lambda raw: raw + b"-- changed\n"),
        ("inventory", "depth-n-minus-1-inventory/wasm.json", lambda raw: changed_json(raw, lambda value: value["modules"]["top"]["ports"].pop(next(iter(value["modules"]["top"]["ports"]))))),
        ("rejection-reason", f"{solver}-depth-n-minus-1/native-formal_trace/rejection.json", lambda raw: changed_json(raw, lambda value: value.update(reason="changed"))),
        ("source", f"{solver}-no-property/pyodide-formal_trace/files/top.v", lambda raw: raw + b"\n// changed\n"),
        ("model", f"{solver}-no-property/pyodide-formal_trace/files/model.smt2", lambda raw: raw + b"\n; changed\n"),
        ("unexpected-artifact", f"{solver}-no-property/pyodide-formal_trace/files/unexpected", lambda raw: b"unexpected"),
        ("plugin", "ghdl-replay-plugin/replay.vpi", lambda raw: raw + b"\0"),
        *children(f"{solver}-depth-n-minus-1/pyodide-formal_trace/", solver),
    ]


def mutations(solver, baseline_error):
    controls = []
    for column in AUDIT.COLUMNS:
        controls.extend([
            ("csv-" + column, "results.csv", lambda raw, column=column: changed_csv(raw, column)),
            ("json-" + column, "results.json", lambda raw, column=column: changed_json(raw, lambda value: value["rows"][0].update({column: "changed"}))),
        ])
    controls.extend(baseline_error_controls(solver) if baseline_error else replay_controls(solver))
    controls.extend([
        ("tool-error-source", f"{solver}-vacuous-assumption/top.vhd", lambda raw: raw + b"-- changed\n"),
        ("tool-error-upstream", f"{solver}-vacuous-assumption/upstream.json", lambda raw: changed_json(raw, lambda value: value.update(exitCode=0))),
        ("process-code-type", f"{solver}-no-property/pyodide-formal_trace/process.json", lambda raw: changed_json(raw, lambda value: value.update(exitCode=False))),
        ("format-type", "metadata.json", lambda raw: changed_json(raw, lambda value: value.update(format=True))),
        ("missing-row", "results.json", lambda raw: changed_json(raw, lambda value: value["rows"].pop())),
        ("duplicate-row", "results.json", lambda raw: changed_json(raw, lambda value: value["rows"].__setitem__(-1, value["rows"][0]))),
        ("duplicate-json-key", "results.json", lambda raw: b'{"a":1,"a":2}'),
        ("nonfinite", "results.json", lambda raw: b'{"a":NaN}'),
        ("unsafe-path", "metadata.json", lambda raw: changed_json(raw, lambda value: value["assets"]["assets"][0].update(path="../outside"))),
        ("baseline-hash", "baseline/results.json", lambda raw: raw + b"\n"),
    ])
    return controls


def formal_controls():
    return [
        ("ghdl-native-bytes", "inputs/ghdl-native/ghdl", lambda raw: raw + b"\0"),
        ("ghdl-wasm-bytes", "inputs/ghdl-wasm/ghdl-synth.wasm", lambda raw: raw + b"\0"),
        ("ghdl-version", "versions/ghdl-native.json", lambda raw: changed_json(raw, lambda value: value.update(stdout="GHDL 0.0.0\n"))),
        ("ghdl-manifest", "build/ghdl-wasm-build-manifest.tsv", lambda raw: raw + b"changed\n"),
    ]


def run(source, out):
    source, out = Path(source).resolve(strict=True), Path(out).absolute()
    AUDIT.require(not out.exists() and not out.is_symlink() and not out.is_relative_to(source), "fresh external mutation directory")
    report = AUDIT.audit(source)
    out.mkdir()
    clone = out / "mutated-evidence"
    shutil.copytree(source, clone, copy_function=os.link, symlinks=True)
    evidence = AUDIT.Evidence(source)
    solver = evidence.data("metadata.json")["solvers"][0]
    baseline_error = any(row["error"] == AUDIT.BASELINE_ERROR for row in evidence.data("results.json")["rows"])
    controls = mutations(solver, baseline_error) + ([] if report["preliminary"] else formal_controls())
    AUDIT.require(len({label for label, _, _ in controls}) == len(controls), "unique mutation labels")
    receipts = []
    for label, name, modify in controls:
        target = clone / name
        raw = target.read_bytes() if target.exists() else None
        changed = modify(raw)
        AUDIT.require(raw != changed, "ineffective mutation: " + label)
        try:
            target.unlink(missing_ok=True)
            if changed is not None:
                target.write_bytes(changed)
            command = [sys.executable, str(Path(__file__).with_name("audit-smt-vhdl-replay.py")), str(clone)]
            if not report["preliminary"]:
                command.append("--formal")
            observed = subprocess.run(command, capture_output=True, timeout=600)
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
    result = {"status": "pass", "preliminary": report["preliminary"], "solver": solver, "controls": receipts}
    (out / "results.json").write_text(json.dumps(result, sort_keys=True) + "\n")
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    result = run(args.source, args.out)
    print(json.dumps({"status": result["status"], "controls": len(result["controls"]), "preliminary": result["preliminary"]}))
