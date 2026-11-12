#!/usr/bin/env python3
"""Independently audit all boundary CSV columns against captured bytes and build inputs."""

import argparse
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = ("case", "runtime", "phase", "status", "binary_sha256", "build_metadata_sha256",
           "input_sha256", "argv_sha256", "stdout_bytes", "stdout_sha256", "stderr_bytes", "stderr_sha256",
           "exit_code", "signal", "process_status", "integrity_verified", "error", "elapsed_ms", "memory_bytes",
           "trace_bytes", "trace_sha256")
IDS = (0, 1, -1, 2, -2, 2147483647, 2147483648, -2147483648,
       4294967295, -4294967295, 4294967297, -4294967297, 9223372036854775807, -9223372036854775807)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    return json.loads(path.read_bytes())


def audit(directory, evidence_root=None, git_repo=ROOT):
    directory = Path(directory).resolve()
    settings = read_json(directory / "settings.json")
    original_root = Path(settings["repository"])
    require(original_root.is_absolute(), "Invalid recorded repository")

    def location(value):
        path = Path(value)
        if not path.is_absolute():
            path = original_root / path
        relative = path.relative_to(original_root)
        require(".." not in relative.parts, "Escaping evidence path")
        return (Path(evidence_root).resolve() if evidence_root else original_root) / relative

    def json_hash(value):
        return sha(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode())

    def git_bytes(commit, path):
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid source commit")
        return subprocess.check_output(["git", "show", f"{commit}:{path}"], cwd=git_repo)

    def hashed_file(path, item):
        data = path.read_bytes()
        require(sha(data) == item["sha256"], f"File hash mismatch: {path}")
        if "bytes" in item:
            require(len(data) == item["bytes"], f"File size mismatch: {path}")
        return data

    formal = settings["phase"] == "formal-probe"
    require(formal or settings["phase"] == "preliminary", "Unknown measurement phase")
    require(not formal or settings["worktree"] == "", "Dirty formal measurement")
    script = (directory / "probe-extra-solver-boundaries.mjs").read_bytes()
    require(sha(script) == settings["script_sha256"], "Runner snapshot mismatch")
    if formal:
        require(script == git_bytes(settings["commit"], "scripts/probe-extra-solver-boundaries.mjs"),
                "Runner commit mismatch")
    controls = settings["unpatched_ids"]
    require(isinstance(controls, bool), "Invalid control selection")
    cases = ("ids",) if controls else ("ids", "trace-plain", "trace-gzip")
    expected_rows = [(runtime, case) for runtime in ("native", "wasi") for case in cases]
    with (directory / "results.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        require(tuple(reader.fieldnames or ()) == COLUMNS, "Unexpected CSV columns")
        rows = list(reader)
    require([(row["runtime"], row["case"]) for row in rows] == expected_rows, "Missing, extra or reordered rows")
    expected_files = {"settings.json", "summary.json", "results.csv", "probe-extra-solver-boundaries.mjs"}
    for runtime in ("native", "wasi"):
        option = f"--{runtime}"
        require(settings["argv"].count(option) == 1, "Ambiguous build argument")
        build_dir = location(settings["argv"][settings["argv"].index(option) + 1])
        metadata = (build_dir / "metadata.json").read_bytes()
        info = json.loads(metadata)
        require(info["status"] == "built" and info["format"] == 1 and info["runtime"] == runtime, "Invalid probe build")
        require(info["unpatched_ids"] is controls, "Control build mismatch")
        require(not formal or info["worktree_status"] == "", "Dirty formal probe build")
        driver = (build_dir / "build-extra-solver-boundaries.py").read_bytes()
        require(sha(driver) == info["script_sha256"], "Probe driver snapshot mismatch")
        harness = (build_dir / "extra-solver-boundary.c").read_bytes()
        require(sha(harness) == info["harness_sha256"], "Probe C snapshot mismatch")
        if formal:
            require(driver == git_bytes(info["base_commit"], "scripts/build-extra-solver-boundaries.py"), "Probe driver commit mismatch")
            require(harness == git_bytes(info["base_commit"], "tests/synth/extra-solver-boundary.c"), "Probe C commit mismatch")
        source_dir = location(info["source_build"])
        source_raw = (source_dir / "metadata.json").read_bytes()
        require(sha(source_raw) == info["source_metadata_sha256"], "Solver metadata mismatch")
        source = json.loads(source_raw)
        require(source["status"] == "built" and source["runtime"] == runtime and source["solver"] == "boolector", "Invalid solver build")
        require(source["worktree_status"] == "" and source["base_commit"] == info["source_build_commit"], "Invalid solver build identity")
        tree = subprocess.check_output(["git", "ls-tree", source["base_commit"], "vendor/boolector"], cwd=git_repo)
        pinned = re.fullmatch(rb"160000 commit ([0-9a-f]{40})\tvendor/boolector\n", tree)
        require(pinned is not None and source["source"]["commit"] == pinned[1].decode(), "Solver source pin mismatch")
        primary_patches = {item["path"] for item in source["patches"]}
        common = {f"patches/cadical-wasi-{name}.patch" for name in ("cross", "pipes", "resources", "alarm")}
        expected_patches = common | {"patches/btor2tools-wasi-ids.patch", "patches/boolector-wasi-trace.patch"}
        require(primary_patches == (expected_patches if runtime == "wasi" else set()) or
                (not formal and controls and runtime == "wasi" and primary_patches == common), "Unexpected solver patch set")
        require(sha(git_bytes(source["base_commit"], "scripts/build-solver-probe.py")) == source["script_sha256"], "Solver driver commit mismatch")
        require(sha((source_dir / source["script_snapshot"]).read_bytes()) == source["script_sha256"], "Solver driver snapshot mismatch")
        for build, parent in ((info, build_dir), (source, source_dir)):
            for item in build["patches"]:
                require(sha((parent / item["snapshot"]).read_bytes()) == item["sha256"], "Patch snapshot mismatch")
                require(sha(git_bytes(build["base_commit"], item["path"])) == item["sha256"], "Patch commit mismatch")
            for command in build["commands"]:
                code = command["exit_code" if build is info else "exit_status"]
                require(code == 0, f"Failed build command: {command['label']}")
                require(sha((parent / f"{command['label']}.log").read_bytes()) == command["log_sha256"], "Build log mismatch")
        artifact = source["artifact"]
        require(artifact["path"] == "objects/bin/boolector", "Unexpected solver artifact path")
        hashed_file(source_dir / artifact["path"], artifact)
        if not controls:
            for item in source["static_libraries"].values():
                hashed_file(source_dir / item["path"], item)
        archive_hash = source["dependencies"]["btor2tools"]["archive_sha256"]
        require(sha((build_dir / "btor2tools-source.tar").read_bytes()) == archive_hash, "BTOR2 source archive mismatch")
        for case in cases:
            row = rows[expected_rows.index((runtime, case))]
            name = f"{runtime}-{case}"
            expected_files.update(f"{name}.{suffix}" for suffix in ("stdin", "stdout", "stderr", "json"))
            record = read_json(directory / f"{name}.json")
            result = record["result"]
            require(row["status"] == "pass" and row["phase"] == settings["phase"], "Failed or inconsistent row")
            for key in COLUMNS:
                value = record["row"][key]
                encoded = "null" if value is None else str(value).lower() if isinstance(value, bool) else str(value)
                if key == "elapsed_ms":
                    require(float(row[key]) == value, "Elapsed CSV mismatch")
                else:
                    require(row[key] == encoded, f"CSV/raw record mismatch: {key}")
            binary = info["artifacts"]["ids" if case == "ids" else "trace"]
            require(binary["path"] == ("ids" if case == "ids" else "trace"), "Unexpected boundary artifact path")
            hashed_file(build_dir / binary["path"], binary)
            require(row["binary_sha256"] == binary["sha256"] and row["build_metadata_sha256"] == sha(metadata), "Row build hash mismatch")
            input_bytes = (directory / f"{name}.stdin").read_bytes()
            require(input_bytes == (b"1 sort bitvec 1\n2 input 1\n" if case == "ids" else b""), "Probe input mismatch")
            require(row["input_sha256"] == sha(input_bytes), "Input hash mismatch")
            argv = record["args"]
            if case == "ids":
                require(argv == (["--alias-only"] if controls else []), "ID argv mismatch")
            else:
                mode = "gzip" if case == "trace-gzip" else "plain"
                extension = "gz" if mode == "gzip" else "txt"
                trace_name = f"{case}.{extension}"
                native_trace = location(Path(original_root / settings["argv"][settings["argv"].index("--out") + 1]) / trace_name)
                if runtime == "native":
                    require(location(argv[1]) == native_trace, "Native trace path mismatch")
                else:
                    require(argv[1] == f"/tmp/boundary-trace.{extension}", "WASI trace path mismatch")
                require(argv[0] == mode and len(argv) == 2, "Trace argv mismatch")
            require(row["argv_sha256"] == json_hash(argv), "Argument hash mismatch")
            out = (directory / f"{name}.stdout").read_bytes()
            err = (directory / f"{name}.stderr").read_bytes()
            for label, data in (("stdout", out), ("stderr", err)):
                require(row[f"{label}_sha256"] == sha(data) and int(row[f"{label}_bytes"]) == len(data), f"{label} mismatch")
            blocked = runtime == "wasi" and case == "trace-gzip"
            negative = runtime == "wasi" and controls
            require(result["status"] == ("runtime-error" if blocked else "exited"), "Unexpected process status")
            require(result["exitCode"] == (None if blocked else 23 if negative else 0), "Unexpected exit code")
            require(result["signal"] is None and result["integrityVerified"] is True, "Signal or integrity failure")
            require(result["error"] == ("unreachable" if blocked else None), "Unexpected process error")
            require(row["process_status"] == result["status"] and row["exit_code"] == ("null" if result["exitCode"] is None else str(result["exitCode"])), "CSV exit mismatch")
            require(row["signal"] == "null" and row["integrity_verified"] == "true", "CSV process mismatch")
            require(row["error"] == ("unreachable" if blocked else "null"), "CSV error mismatch")
            elapsed = record["ended_ms"] - record["started_ms"]
            require(math.isfinite(elapsed) and 0 < elapsed < 60000 and elapsed == float(row["elapsed_ms"]), "Invalid elapsed measurement")
            memory = None if runtime == "native" or blocked else 33554432
            require(result["memoryBytes"] == memory and row["memory_bytes"] == ("null" if memory is None else str(memory)), "Unexpected memory metadata")
            if runtime == "wasi":
                require(result["sha256"] == binary["sha256"] and result["stdoutBytes"] == len(out) and result["stderrBytes"] == len(err), "Worker byte count mismatch")
            if case == "ids":
                expected_ids = [value for value in IDS if not controls or abs(value) != 2147483648]
                parsed = [tuple(map(int, line)) for line in re.findall(rb"^id=(-?\d+) found=(\d+)\n", out, re.MULTILINE)]
                require(out == b"".join(f"id={value} found={found}\n".encode() for value, found in parsed), "Invalid ID output framing")
                require([value for value, _ in parsed] == expected_ids, "ID coverage mismatch")
                for value, found in parsed:
                    magnitude = abs(value)
                    expected = magnitude if magnitude in (1, 2) else 1 if negative and magnitude in (4294967295, 4294967297, 9223372036854775807) else 0
                    require(found == expected, "ID width result mismatch")
                require(not err, "Unexpected ID stderr")
            elif blocked:
                require(out == b"trace-requested\n" and err == b"Boolector: gzip API traces are unavailable on WASI\n", "Gzip rejection mismatch")
            else:
                require(out == b"trace-requested\ntrace-opened\n" and not err, "Plain/native trace mismatch")
            if runtime == "native" and case != "ids":
                expected_files.add(trace_name)
                trace = native_trace.read_bytes()
                require(int(row["trace_bytes"]) == len(trace) and row["trace_sha256"] == sha(trace), "Native trace hash mismatch")
                decoded = gzip.decompress(trace) if case == "trace-gzip" else trace
                require(re.fullmatch(rb"boundary-probe\ndelete (?:0x)?[0-9a-f]+\n", decoded), "Native trace content mismatch")
            else:
                require(row["trace_bytes"] == row["trace_sha256"] == "null", "Unexpected exported trace metadata")
    summary = read_json(directory / "summary.json")
    require(summary == {"status": "pass", "commit": settings["commit"], "phase": settings["phase"],
                        "cases": len(cases), "executions": len(rows), "csv_sha256": sha((directory / "results.csv").read_bytes())}, "Summary mismatch")
    require({path.name for path in directory.iterdir()} == expected_files, "Missing or extra measurement files")
    return {"status": "pass", "phase": settings["phase"], "rows": len(rows), "columns": len(COLUMNS)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--evidence-root", type=Path)
    parser.add_argument("--git-repo", type=Path, default=ROOT)
    arguments = parser.parse_args()
    print(json.dumps(audit(arguments.input, arguments.evidence_root, arguments.git_repo)))
