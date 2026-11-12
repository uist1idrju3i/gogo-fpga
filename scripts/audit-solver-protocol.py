#!/usr/bin/env python3
"""Audit complete protocol evidence independently of the JavaScript comparator."""

import argparse
import csv
import hashlib
import io
import json
import math
import re
import statistics
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
COLUMNS = """phase repeat solver runtime case verdict executed status exit_code signal
elapsed_ms native_max_rss_kib wasm_memory_bytes stdout_bytes stderr_bytes frame_count
integrity_verified binary_sha256 transmitted_sha256 source_commit binary_build_commit
harness_commit script_sha256 patches_sha256 gmp_archive_sha256 sdk_archive_sha256
metadata_sha256 stdout_sha256 stderr_sha256 frames_sha256 failure""".split()
NORMAL = ["incremental-bv", "incremental-array", "long-value", "malformed", "missing-response"]
WORKER = ["timeout", "cancel", "busy-timeout", "busy-cancel", "stale", "hash-mismatch",
          "corrupt-wasm", "worker-crash", "missing-termination", "output-limit"]
SPECIAL = {"yices2": ["unsupported-alarm"], "z3": ["unknown", "software-fp", "unsupported-hwf"]}
PAIRED = NORMAL + ["unknown", "software-fp"]
CONTROLS = ["stdout", "stderr", "status", "exit", "frames", "signal", "framing"]
REQUIRED_SOURCES = ["scripts/measure-solver-protocol.mjs", "scripts/audit-solver-protocol.py", "scripts/build-solver-probe.py",
                    "tests/synth/solver-protocol-helpers.mjs", "tests/synth/solver-protocol-cases.mjs",
                    "tests/web/solver-process-helpers.mjs", "tests/web/solver-node-worker.mjs", "web/lib/solver-process.mjs",
                    "web/lib/solver-job.mjs", "web/lib/byte-pipe.mjs", "web/lib/smt-response-framer.mjs", "web/lib/wasi-p1.mjs"]


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return str(value).lower()
    return str(value)


def stats(values):
    present = [v for v in values if v is not None]
    return {"count": len(present), "missing": len(values) - len(present),
            "min": min(present) if present else None,
            "median": statistics.median(present) if present else None,
            "max": max(present) if present else None}


def audit(directory, preliminary=False):
    directory = Path(directory)
    def read(name):
        return (directory / name).read_bytes()
    def data(name):
        return json.loads(read(name))
    end = data("metadata-end.json")
    start = data("metadata-start.json")
    require(start["format"] == end["format"] and type(end["format"]) is int and end["format"] in [2, 3], "evidence format")
    require(re.fullmatch(r"[a-f0-9]{40}", end["harnessCommit"]) is not None, "invalid harness commit")
    require(end["status"] == "pass" and end["errors"] == [], "unsuccessful trial")
    require(type(end["preliminary"]) is bool and end["preliminary"] == preliminary, "trial mode")
    for key in ["harnessCommit", "worktreeStatus", "sources", "manifestSha256", "startedUnix",
                "preliminary", "repeats", "aa", "node", "v8", "timeVersion", "host", "submodules"]:
        require(start[key] == end[key], f"changed start metadata: {key}")
    for key in ["node", "v8", "timeVersion", "sources", "host"]:
        require(bool(end[key]), f"missing environment: {key}")
    require(math.isfinite(end["endedUnix"]) and end["endedUnix"] >= end["startedUnix"], "trial timestamps")
    require(type(end["repeats"]) is int and end["repeats"] >= (1 if preliminary else 5), "repetition count")
    require(type(end["aa"]) is int and end["aa"] >= (0 if preliminary else 2), "A/A count")
    if not preliminary:
        require(end["worktreeStatus"] == "", "dirty formal harness")
    manifest = data("probes-manifest.json")
    require(bool(manifest) and set(manifest) <= SPECIAL.keys(), "solver manifest")
    if not preliminary:
        require(set(manifest) == set(SPECIAL), "formal P2 requires both solvers")
    require(digest(read("probes-manifest.json")) == end["manifestSha256"], "manifest hash")
    require(set(REQUIRED_SOURCES) <= end["sources"].keys(), "missing harness source snapshot")
    for name, sha in end["sources"].items():
        snapshot = read(name.replace("/", "__"))
        require(digest(snapshot) == sha, f"source snapshot: {name}")
        if not preliminary:
            original = subprocess.check_output(["git", "show", f'{end["harnessCommit"]}:{name}'], cwd=ROOT)
            require(snapshot == original, f"source is not measured commit: {name}")
    probes = end["probes"]
    require(set(probes) == {f"{s}-{r}" for s in manifest for r in ["native", "wasi"]}, "probe set")
    for solver, targets in manifest.items():
        require(set(targets) == {"native", "wasi"}, "runtime set")
        for runtime in targets:
            label = f"{solver}-{runtime}"
            probe = probes[label]
            raw = read(label + ".metadata.json")
            require(digest(raw) == probe["metadataSha256"], f"build metadata hash: {label}")
            require(json.loads(raw) == {k: v for k, v in probe.items() if k not in ["metadataSha256", "actualVersion"]}, "build metadata content")
            require(probe["status"] == "built" and probe["worktree_status"] == "", "unclean build")
            require(probe["solver"] == solver and probe["runtime"] == runtime, "build identity")
            require(re.fullmatch(r"[a-f0-9]{40}", probe["base_commit"]) is not None, "invalid build commit")
            require(type(probe["artifact"]["bytes"]) is int and probe["artifact"]["bytes"] > 0, "artifact size")
            require(bool(probe["compiler"]), "missing actual compiler")
            if solver == "z3":
                require(bool(probe["compiler_cxx"]), "missing actual C++ compiler")
            labels = [c["label"] for c in probe["commands"]]
            require(len(labels) == len(set(labels)) and {"configure", "build"} <= set(labels), "build command coverage")
            for command in probe["commands"]:
                require(re.fullmatch(r"[a-zA-Z0-9-]+", command["label"]) is not None, "invalid build log label")
                require(type(command["exit_status"]) is int and command["exit_status"] == 0, "unsuccessful build command")
                require(digest(read(f'{label}.{command["label"]}.log')) == command["log_sha256"], "raw build log hash")
            require(probe["source"]["version"].removeprefix("yices-").removeprefix("z3-") in probe["actualVersion"], "actual solver version")
            if end["format"] == 3:
                require(digest(read(label + ".build-script.py")) == probe["script_sha256"], "build script snapshot hash")
            else:
                require(probe["script_sha256"] == end["sources"]["scripts/build-solver-probe.py"], "build script hash")
            for patch in probe["patches"]:
                require(patch["sha256"] == end["sources"][patch["path"]], "patch snapshot hash")
            if not preliminary:
                tree = subprocess.check_output(["git", "ls-tree", end["harnessCommit"], f"vendor/{solver}"], cwd=ROOT).decode()
                require(tree.split()[2] == probe["source"]["commit"], "solver source pin")
                original = subprocess.check_output(["git", "show", f'{probe["base_commit"]}:scripts/build-solver-probe.py'], cwd=ROOT)
                require(digest(original) == probe["script_sha256"], "measured build commit script")
    raw = read("results.csv")
    require(digest(raw) == end["csvSha256"], "CSV hash")
    reader = csv.DictReader(io.StringIO(raw.decode()), strict=True)
    require(reader.fieldnames == COLUMNS, "CSV columns")
    rows = list(reader)
    phases = (["aa"] if end["aa"] else []) + ["preliminary" if preliminary else "formal"]
    expected = []
    for phase in phases:
        for repeat in range(1, (end["aa"] if phase == "aa" else end["repeats"]) + 1):
            for solver in manifest:
                for case in NORMAL + WORKER + SPECIAL[solver]:
                    runtimes = (["native", "wasi"] if repeat % 2 else ["wasi", "native"]) if case in PAIRED + ["unsupported-hwf"] else ["wasi"]
                    expected.extend((phase, str(repeat), solver, r, case) for r in runtimes)
    signatures = [tuple(row[k] for k in ["phase", "repeat", "solver", "runtime", "case"]) for row in rows]
    require(signatures == expected and len(rows) == end["rows"], "matrix coverage, duplicates, or execution order")
    groups, paired, aa, control_keys = {}, {}, {}, []
    for row in rows:
        require(set(row) == set(COLUMNS) and all(v is not None for v in row.values()), "invalid CSV row")
        phase, repeat, solver, runtime, case = (row[k] for k in ["phase", "repeat", "solver", "runtime", "case"])
        label = "-".join([phase, repeat, solver, runtime, case])
        rec = data(label + ".json")
        probe = probes[f"{solver}-{runtime}"]
        fields = dict(zip(["phase", "repeat", "solver", "runtime", "case"], [phase, repeat, solver, runtime, case]))
        for col, key in {"verdict": "verdict", "executed": "executed", "status": "status", "exit_code": "exitCode", "signal": "signal",
                         "native_max_rss_kib": "nativeMaxRssKiB", "wasm_memory_bytes": "memoryBytes", "integrity_verified": "integrityVerified",
                         "transmitted_sha256": "transmittedSha256", "failure": "failure"}.items():
            fields[col] = cell(rec.get(key))
        fields.update(binary_sha256=probe["artifact"]["sha256"], source_commit=probe["source"]["commit"],
                      binary_build_commit=probe["base_commit"], harness_commit=end["harnessCommit"], script_sha256=probe["script_sha256"],
                      patches_sha256=digest(compact(probe["patches"])), gmp_archive_sha256=(probe.get("gmp") or {}).get("archive_sha256", ""),
                      sdk_archive_sha256=(probe.get("wasi_sdk") or {}).get("archive_sha256", ""), metadata_sha256=probe["metadataSha256"])
        for channel in ["stdout", "stderr", "frames"]:
            blob = read(label + (".frames.json" if channel == "frames" else "." + channel))
            sha = digest(blob)
            fields[channel + "_sha256"] = sha
            require(rec[channel + "Sha256"] == sha, f"raw log hash: {label} {channel}")
            fields["frame_count" if channel == "frames" else channel + "_bytes"] = str(len(json.loads(blob)) if channel == "frames" else len(blob))
        require(set(fields) | {"elapsed_ms"} == set(COLUMNS), "auditor omits a column")
        for key, value in fields.items():
            require(row[key] == value, f"CSV mismatch: {label} {key}")
        elapsed = float(row["elapsed_ms"])
        require(type(rec["elapsedMs"]) in [int, float] and math.isfinite(elapsed) and elapsed > 0 and elapsed == rec["elapsedMs"], "elapsed time")
        require(rec["case"] == case and rec["verdict"] == "pass" and rec["failure"] is None, "failed contract")
        require(rec["executed"] is (case not in ["hash-mismatch", "corrupt-wasm", "worker-crash"]), "execution witness")
        if case == "hash-mismatch":
            require(rec["transmittedSha256"] == "0" * 64, "hash mismatch control")
        if case not in ["hash-mismatch", "corrupt-wasm"]:
            require(rec["transmittedSha256"] == probe["artifact"]["sha256"], "executed binary hash")
        elif case == "corrupt-wasm":
            require(rec["transmittedSha256"] != probe["artifact"]["sha256"], "corrupt binary witness")
        for key in ["nativeMaxRssKiB", "memoryBytes"]:
            value = rec.get(key)
            require(value is None or (type(value) is int and value > 0), f"invalid resource metric: {key}")
        if runtime == "native":
            require(rec.get("memoryBytes") is None and rec.get("nativeMaxRssKiB") is not None, "native resource type")
            require(int(read(label + ".rss").strip()) == rec["nativeMaxRssKiB"], "raw RSS")
        else:
            require(rec.get("nativeMaxRssKiB") is None and type(rec["integrityVerified"]) is bool, "WASM resource type")
        status = {"timeout": "timeout", "busy-timeout": "timeout", "cancel": "cancelled", "busy-cancel": "cancelled", "hash-mismatch": "integrity-error",
                  "corrupt-wasm": "invalid-wasm", "worker-crash": "crashed", "missing-termination": "timeout", "output-limit": "output-limit"}.get(case, "exited")
        require(rec["status"] == status and rec.get("signal") is None, "termination classification")
        frames = data(label + ".frames.json")
        if status == "exited":
            nonzero = (case == "malformed" and solver == "z3") or (case == "unsupported-alarm") or (case == "unsupported-hwf" and runtime == "wasi")
            require(type(rec["exitCode"]) is int and (rec["exitCode"] != 0) == nonzero, "exit code contract")
            if runtime == "wasi":
                require(rec["integrityVerified"] and rec.get("memoryBytes") is not None, "terminated WASM evidence")
        else:
            require(rec["exitCode"] is None, "fabricated exit code")
        if case in ["incremental-bv", "incremental-array", "stale"]:
            require(len(frames) == 5 and frames[0] == "sat" and frames[2:4] == ["unsat", "sat"] and "define-fun" in frames[4], "incremental responses")
        elif case == "long-value":
            value = "((big\n  #b" + "0" * 32767 + "1))" if solver == "yices2" else "((big #x" + "0" * 8191 + "1))"
            require(frames == ["sat", value], "long response oracle")
        elif case in ["malformed", "unsupported-hwf"]:
            prefix = "(goals" if case == "unsupported-hwf" and runtime == "native" else "(error "
            require(bool(frames) and all(f.startswith(prefix) for f in frames), "diagnostic is not a proof")
            if case == "unsupported-hwf" and runtime == "wasi":
                require(any("hardware floating-point rounding is unsupported" in f for f in frames), "hwf rejection")
        elif case == "unknown":
            require(len(frames) == 2 and frames[0] == "unknown" and "reason-unknown" in frames[1], "unknown is not a proof")
        elif case == "software-fp":
            require(frames == ["sat", "(((fp.to_ieee_bv f) #x3f800000))", "unsat", "sat"], "software FP oracle")
        elif case in ["missing-response", "hash-mismatch", "corrupt-wasm", "worker-crash", "unsupported-alarm"]:
            require(frames == [], "unexpected response")
        else:
            require(frames == ["sat"], "lifecycle starting response")
        if case == "unsupported-alarm":
            require(b"WASI alarms are unsupported; use a host worker deadline" in read(label + ".stderr"), "alarm rejection")
        if case != "output-limit":
            require(rec["framingError"] is None, "response framing error")
        witness = tuple(rec.get(k) for k in ["status", "exitCode", "signal", "framingError", "stdoutSha256", "stderrSha256", "framesSha256"])
        key = (phase, repeat, solver, case)
        if case in PAIRED:
            if key in paired:
                require(paired[key] == witness, "native/WASM byte parity")
            paired[key] = witness
        if phase == "aa" and case in PAIRED + ["stale", "unsupported-alarm", "unsupported-hwf"]:
            aa_key = (solver, runtime, case)
            if aa_key in aa:
                require(aa[aa_key] == witness, "A/A mismatch")
            aa[aa_key] = witness
        if runtime == "wasi" and case in ["incremental-bv", "incremental-array", "long-value"]:
            control_keys.append((phase, int(repeat), solver, case, label))
        group = groups.setdefault("/".join([phase, solver, runtime, case]), {"elapsed_ms": [], "native_max_rss_kib": [], "wasm_memory_bytes": []})
        group["elapsed_ms"].append(elapsed)
        group["native_max_rss_kib"].append(rec.get("nativeMaxRssKiB"))
        group["wasm_memory_bytes"].append(rec.get("memoryBytes"))
    controls = data("controls.json")
    require([(c["phase"], c["repeat"], c["solver"], c["case"], c["derivedFrom"]) for c in controls] == control_keys, "negative-control matrix")
    for control in controls:
        require(control["checks"] == [{"control": k, "detected": True} for k in CONTROLS], "undetected negative control")
    return {"format": 1, "status": "pass", "preliminary": preliminary, "harnessCommit": end["harnessCommit"],
            "rows": len(rows), "columns": len(COLUMNS), "csvSha256": digest(raw), "negativeControls": len(controls) * len(CONTROLS),
            "resources": {k: {metric: stats(values) for metric, values in v.items()} for k, v in groups.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--preliminary", action="store_true")
    args = parser.parse_args()
    report = audit(args.directory, args.preliminary)
    with args.out.open("x") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(f"Audited {report['rows']} rows, {report['columns']} columns, {report['negativeControls']} negative controls")


if __name__ == "__main__":
    main()
