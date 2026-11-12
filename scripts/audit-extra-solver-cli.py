#!/usr/bin/env python3
"""Independently audit extra-solver CLI bytes, every CSV column and build provenance."""

import argparse
import configparser
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
COLUMNS = tuple("runtime case status exit_code signal elapsed_ms wasm_memory_bytes input_sha256 stdout_sha256 stderr_sha256 binary_sha256 build_commit metadata_sha256 write_error".split())
SOURCES = ("scripts/probe-extra-solver-cli.mjs", "tests/synth/solver-protocol-helpers.mjs",
           "tests/web/solver-process-helpers.mjs", "tests/web/solver-node-worker.mjs",
           "web/lib/solver-process.mjs", "web/lib/solver-job.mjs", "web/lib/byte-pipe.mjs",
           "web/lib/smt-response-framer.mjs", "web/lib/wasi-p1.mjs", "web/solver-worker.mjs",
           "scripts/audit-extra-solver-cli.py", "tests/check-solver-protocol/test_extra_cli_audit.py")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fixtures():
    args = ["--lang=smt2"]
    cases = [
        {"name": "version", "args": ["--version"], "input": "", "exit": 0},
        {"name": "help", "args": ["--help"], "input": "", "exit": 0},
        {"name": "values-push-pop", "args": args, "exit": 0,
         "input": "(set-option :produce-models true)(set-logic QF_BV)(declare-fun x () (_ BitVec 8))(assert (= x #x2a))(check-sat)(get-value (x))(push 1)(assert (= x #x2b))(check-sat)(pop 1)(check-sat)\n",
         "stdout": "sat\n((x #b00101010))\nunsat\nsat\n"},
        {"name": "eof", "args": args, "input": "(set-logic QF_BV)(check-sat)\n", "exit": 0, "stdout": "sat\n"},
        {"name": "syntax", "args": args, "input": "(set-logic QF_BV)(not-a-command)\n", "exit": 1},
        {"name": "model", "args": args, "exit": 0,
         "input": "(set-option :produce-models true)(set-logic QF_BV)(declare-fun x () (_ BitVec 8))(assert (= x #x2a))(check-sat)(get-model)\n",
         "stdout": "sat\n(\n  (define-fun x () (_ BitVec 8) #b00101010)\n)\n"},
        {"name": "time-limit-boundary", "args": [*args, "--time-limit=10000"], "exit": 0,
         "input": "(set-logic QF_BV)(check-sat)\n", "stdout": "sat\n",
         "wasi": {"status": "runtime-error", "exit": None, "stdout": "",
                  "stderr": "Bitwuzla: threaded CLI time limits are unavailable on WASI\n"}},
    ]
    for mode, expected in (("RNE", "#x3f800000"), ("RNA", "#x3f800001"), ("RTP", "#x3f800001"),
                           ("RTN", "#x3f800000"), ("RTZ", "#x3f800000")):
        cases.append({"name": f"fp-round-{mode}", "args": args, "exit": 0, "stdout": "unsat\n",
                      "input": f"(set-logic QF_FP)(assert (not (= (fp.add {mode} ((_ to_fp 8 24) #x3f800000) ((_ to_fp 8 24) #x33800000)) ((_ to_fp 8 24) {expected}))))(check-sat)\n"})
    cases.extend([
        {"name": "fp-nan", "args": args, "exit": 0, "stdout": "unsat\n",
         "input": "(set-logic QF_FP)(assert (not (fp.isNaN (fp.div RNE (_ +zero 8 24) (_ +zero 8 24)))))(check-sat)\n"},
        {"name": "array-store", "args": args, "exit": 0, "stdout": "unsat\n",
         "input": "(set-logic QF_ABV)(declare-fun a () (Array (_ BitVec 8) (_ BitVec 8)))(assert (not (= (select (store a #x2a #x7f) #x2a) #x7f)))(check-sat)\n"},
    ])
    return cases


def audit(directory, evidence_root=None, git_repo=ROOT):
    directory = Path(directory).resolve()
    setup = json.loads((directory / "setup.json").read_bytes())
    require(setup["format"] == 2 and setup["solver"] == "bitwuzla", "Unsupported CLI evidence")
    require(setup["phase"] in ("preliminary", "formal-probe"), "Invalid measurement phase")
    formal = setup["phase"] == "formal-probe"
    require(not formal or setup["worktree"] == "", "Dirty formal measurement")
    original = Path(setup["repository"])
    require(original.is_absolute(), "Invalid repository path")

    def location(value):
        path = Path(value)
        relative = (path if path.is_absolute() else original / path).relative_to(original)
        require(".." not in relative.parts, "Escaping evidence path")
        return (Path(evidence_root).resolve() if evidence_root else original) / relative

    def git_bytes(commit, file):
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid commit")
        return subprocess.check_output(["git", "show", f"{commit}:{file}"], cwd=git_repo)

    def hashed(file, digest, length=None):
        base = Path(evidence_root).resolve() if evidence_root else original
        require(file.resolve().is_relative_to(base.resolve()) and not file.is_symlink(), "Unsafe hashed evidence path")
        data = file.read_bytes()
        require(sha(data) == digest and (length is None or len(data) == length), f"Hashed bytes differ: {file}")
        return data

    require(set(setup["sources"]) == set(SOURCES), "Incomplete harness sources")
    for file in SOURCES:
        data = hashed(directory / file.replace("/", "__"), setup["sources"][file])
        require(data == git_bytes(setup["commit"], file), "Harness commit mismatch")
    cases = fixtures()
    require(setup["cases"] == cases, "Changed CLI fixtures")
    require(len(setup["builds"]) == 2 and setup["negative_build"] is not None, "Missing build or negative control")
    builds = [*setup["builds"], setup["negative_build"]]
    require([item["runtime"] for item in builds] == ["native", "wasi", "wasi"], "Build order mismatch")
    require(builds[0]["base_commit"] == builds[1]["base_commit"], "Native/WASI build commits differ")
    binary_hashes = []
    metadata_hashes = []
    for index, expected_info in enumerate(builds):
        option = ("--native", "--wasi", "--negative-wasi")[index]
        require(setup["argv"].count(option) == 1, "Ambiguous build selection")
        raw_path = setup["argv"][setup["argv"].index(option) + 1]
        original_build = Path(raw_path) if Path(raw_path).is_absolute() else original / raw_path
        build = location(raw_path)
        raw = hashed(build / "metadata.json", expected_info["metadata_sha256"])
        info = json.loads(raw)
        require(info == {key: value for key, value in expected_info.items() if key != "metadata_sha256"}, "Build metadata differs")
        require(info["status"] == "built" and info["solver"] == "bitwuzla" and info["format"] == 1, "Unsuccessful solver build")
        require(info["worktree_status"] == "", "Dirty solver build")
        commit = info["base_commit"]
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid build commit")
        tree = subprocess.check_output(["git", "ls-tree", commit, "vendor/bitwuzla"], cwd=git_repo)
        require(tree == f"160000 commit {info['source']['commit']}\tvendor/bitwuzla\n".encode(), "Solver gitlink differs")
        require(info["script_snapshot"] == "build-solver-probe.py", "Unexpected builder snapshot")
        driver = hashed(build / info["script_snapshot"], info["script_sha256"])
        require(driver == git_bytes(commit, "scripts/build-solver-probe.py"), "Builder commit mismatch")
        patches = {item["path"] for item in info["patches"]}
        common = {"patches/bitwuzla-wasi-time-limit.patch", "patches/bitwuzla-wasi-rss.patch",
                  "patches/cadical-wasi-process-boundary.patch", "patches/cadical-wasi-random-seed.patch"}
        limb = {"patches/bitwuzla-gmp-limb-width.patch"}
        expected_patches = limb if index == 0 else common if index == 2 else common | limb | {"patches/bitwuzla-wasi-exit.patch"}
        require(patches == expected_patches and len(patches) == len(info["patches"]), "Unexpected patch set")
        for item in info["patches"]:
            require(hashed(build / item["snapshot"], item["sha256"]) == git_bytes(commit, item["path"]), "Patch commit mismatch")
        for command in info["commands"]:
            require(type(command["exit_status"]) is int and command["exit_status"] == 0, "Failed build command")
            require(re.fullmatch(r"[a-z][a-z0-9-]*", command["label"]), "Invalid command label")
            hashed(build / f"{command['label']}.log", command["log_sha256"])
        configure = [item for item in info["commands"] if item["label"] == "configure"]
        require(len(configure) == 1, "Missing Meson configure")
        for flag in ("--wrap-mode=nodownload", "-Dtesting=disabled", "-Dunit_testing=disabled",
                     "-Ddefault_library=static", "-Doptimization=2", "-Dstrip=false"):
            require(configure[0]["argv"].count(flag) == 1, "Invalid Meson configuration")
        meson = re.search(rb"^meson==([^\s\\]+)", git_bytes(commit, "requirements-formal-build.txt"), re.M)
        require(meson is not None and info["meson"].strip() == meson[1].decode(), "Unexpected Meson version")
        research = git_bytes(commit, "RESEARCH.md").decode()
        for name in ("gmp", "mpfr"):
            pins = re.findall(rf"^\| {name} \| ([0-9.]+) \| `([0-9a-f]{{64}})` \| `([^`]+)` \|$", research, re.M)
            require(len(pins) == 1, "Missing arithmetic archive pin")
            version, digest, url = pins[0]
            require(info[name]["version"] == version and info[name]["archive_sha256"] == digest, "Arithmetic pin differs")
            archive = build / url.rsplit("/", 1)[-1]
            hashed(archive, digest)
            require(bool(info[name]["licenses"]), "Missing arithmetic licenses")
            with tarfile.open(archive) as entries:
                for file, digest in info[name]["licenses"].items():
                    data = hashed(build / f"{name}-source" / file, digest)
                    member = entries.extractfile(f"{name}-{version}/{file}")
                    require(member is not None and member.read() == data, "Arithmetic license differs from archive")
        upstream = Path(git_repo) / "vendor/bitwuzla"
        source_commit = info["source"]["commit"]

        def upstream_bytes(file):
            return subprocess.check_output(["git", "show", f"{source_commit}:{file}"], cwd=upstream)

        require(set(info["wraps"]) == set(info["dependencies"]) == {"cadical", "symfpu"}, "Incomplete dependency closure")
        for name, section in (("cadical", "wrap-file"), ("symfpu", "wrap-git")):
            file = f"subprojects/{name}.wrap"
            data = hashed(build / "source" / file, info["wraps"][name]["wrap_sha256"])
            require(data == upstream_bytes(file), "Upstream wrap differs")
            parser = configparser.ConfigParser(interpolation=None)
            parser.read_string(data.decode())
            wrap = {**parser[section], "wrap_sha256": sha(data)}
            require(wrap == info["wraps"][name] and wrap["patch_directory"] == name, "Changed wrap declaration")
            dependency = info["dependencies"][name]
            if name == "cadical":
                require(dependency["url"] == wrap["source_url"] and dependency["archive_sha256"] == wrap["source_hash"], "CaDiCaL archive pin differs")
                archive = build / wrap["source_filename"]
                target = wrap["directory"]
                prefix = target + "/"
            else:
                require(dependency["url"] == wrap["url"] and dependency["commit"] == wrap["revision"], "SymFPU source pin differs")
                archive = build / "symfpu-source.tar"
                target = "symfpu"
                prefix = ""
            hashed(archive, dependency["archive_sha256"])
            require(bool(dependency["licenses"]), "Missing dependency licenses")
            with tarfile.open(archive) as entries:
                if name == "symfpu":
                    require(entries.pax_headers.get("comment") == wrap["revision"], "Wrong git archive source commit")
                for file, digest in dependency["licenses"].items():
                    data = hashed(build / "source/subprojects" / target / file, digest)
                    member = entries.extractfile(prefix + file)
                    require(member is not None and member.read() == data, "Dependency license differs from archive")
            overlay_prefix = f"subprojects/packagefiles/{name}/"
            tree = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", source_commit, "--", overlay_prefix], cwd=upstream).decode().splitlines()
            require(bool(tree) and set(tree) == {overlay_prefix + file for file in dependency["overlay"]}, "Incomplete Meson overlay")
            for file, digest in dependency["overlay"].items():
                data = hashed(build / "source" / overlay_prefix / file, digest)
                require(data == upstream_bytes(overlay_prefix + file), "Upstream overlay differs")
                require(hashed(build / "source/subprojects" / target / file, digest) == data, "Applied Meson overlay differs")
        hashed(build / "meson-machine.ini", info["meson_machine_sha256"])
        if index:
            require(info["bitwuzla_native_rss_available"] is False and info["cadical_native_rss_available"] is False, "RSS boundary missing")
            adapter = hashed(build / "wasi-meson-compiler.py", info["meson_compiler_adapter_sha256"])
            require(adapter == git_bytes(commit, "scripts/wasi-meson-compiler.py"), "Compiler adapter differs")
        entries = info["meson_dependencies"]
        found = {entry["name"]: entry for entry in entries}
        require(len(found) == len(entries) and {"gmp", "mpfr"} <= set(found) <= {"gmp", "mpfr", "threads"}, "Unexpected Meson dependencies")
        prefix = original_build / "dependencies"
        for name, headers in (("gmp", ("gmp.h", "gmpxx.h")), ("mpfr", ("mpfr.h",))):
            require(set(info[name]["headers"]) == set(headers), "Missing staged headers")
            for header in headers:
                hashed(build / "dependencies/include" / header, info[name]["headers"][header])
            archives = [str(prefix / f"lib/lib{name}.a")]
            if name == "mpfr":
                archives.append(str(prefix / "lib/libgmp.a"))
            require(found[name]["version"] == info[name]["version"] and found[name]["compile_args"] == [f"-I{prefix}/include"] and found[name]["link_args"] == archives, "Host arithmetic dependency")
            require(info["libraries"][f"dependencies/lib/lib{name}.a"]["sha256"] == info[name]["library_sha256"], "Arithmetic library identities differ")
        require(info["libraries"] and {"dependencies/lib/libgmp.a", "dependencies/lib/libmpfr.a"} <= set(info["libraries"]), "Missing static libraries")
        for file, item in info["libraries"].items():
            hashed(build / file, item["sha256"], item["bytes"])
        artifact = info["artifact"]
        require(artifact["path"] == "objects/src/main/bitwuzla", "Unexpected solver artifact")
        binary = hashed(build / artifact["path"], artifact["sha256"], artifact["bytes"])
        require(binary.startswith(b"\x7fELF" if index == 0 else b"\0asm\x01\0\0\0"), "Wrong artifact format")
        binary_hashes.append(artifact["sha256"])
        metadata_hashes.append(sha(raw))

    with (directory / "results.csv").open(newline="") as stream:
        reader = csv.DictReader(stream)
        require(tuple(reader.fieldnames or ()) == COLUMNS, "Unexpected CLI CSV columns")
        rows = list(reader)
    syntax = next(case for case in cases if case["name"] == "syntax")
    matrix = [(index, runtime, case) for case in cases for index, runtime in enumerate(("native", "wasi"))]
    matrix.append((2, "wasi", {**syntax, "name": "syntax-before-exit-fix", "status": "runtime-error", "exit": None, "stdout": ""}))
    require(len(rows) == len(matrix), "Missing or extra CLI rows")
    expected_files = {"setup.json", "summary.json", "results.csv", *(file.replace("/", "__") for file in SOURCES)}
    outputs = {}
    for row, (index, runtime, fixture) in zip(rows, matrix):
        name = f"{runtime}-{fixture['name']}"
        expected_files.update(f"{name}.{suffix}" for suffix in ("json", "stdin", "stdout", "stderr"))
        record = json.loads((directory / f"{name}.json").read_bytes())
        require(record["runtime"] == runtime and record["case"] == fixture["name"], "CLI row order differs")
        stdin = hashed(directory / f"{name}.stdin", record["input_sha256"])
        require(stdin == fixture["input"].encode() and record["args"] == fixture["args"], "CLI input or arguments differ")
        out = hashed(directory / f"{name}.stdout", record["stdout_sha256"])
        err = hashed(directory / f"{name}.stderr", record["stderr_sha256"])
        result = record["result"]
        expected = {"status": "exited", **fixture, **(fixture.get("wasi", {}) if runtime == "wasi" else {})}
        require(result["status"] == record["status"] == expected["status"], "Unexpected process status")
        require(result["exitCode"] == record["exit_code"] == expected["exit"] and (record["exit_code"] is None or type(record["exit_code"]) is int), "Unexpected exit code")
        require(record["signal"] is None and result.get("signal") is None, "Unexpected signal")
        require(record["binary_sha256"] == binary_hashes[index] and record["build_commit"] == builds[index]["base_commit"] and record["metadata_sha256"] == metadata_hashes[index], "Wrong binary or metadata identity")
        require(all(type(record[key]) in (int, float) and math.isfinite(record[key]) and record[key] >= 0 for key in ("started_ms", "ended_ms", "elapsed_ms")), "Invalid elapsed time")
        elapsed = record["ended_ms"] - record["started_ms"]
        require(math.isfinite(elapsed) and elapsed >= 0 and elapsed == record["elapsed_ms"], "Invalid elapsed time")
        memory = result["memoryBytes"]
        require(record["wasm_memory_bytes"] == memory, "Memory fields differ")
        if runtime == "wasi" and expected["status"] == "exited":
            require(type(memory) is int and 33554432 <= memory <= 536870912 and memory % 65536 == 0, "Invalid WASM memory")
        else:
            require(memory is None, "Unavailable memory recorded as measured")
        if runtime == "wasi":
            require(result["integrityVerified"] is True and result["sha256"] == binary_hashes[index], "Worker integrity check missing")
            require(result["stdoutBytes"] == len(out) and result["stderrBytes"] == len(err), "Worker output lengths differ")
        if expected["status"] == "runtime-error":
            require(result["error"] == "unreachable", "Wrong unsupported-boundary error")
        else:
            require(result.get("error") is None, "Unexpected runtime error")
        if fixture["name"].startswith("syntax"):
            require(err == b"[error] <stdin>:1:19: expected command at 'not-a-command'\n" and out == b"", "Wrong syntax diagnostic")
        else:
            require(err == expected.get("stderr", "").encode(), "Unexpected stderr")
        if "stdout" in expected:
            require(out == expected["stdout"].encode(), "Unexpected stdout")
        if fixture["name"] == "version":
            require(out.decode().strip() == builds[index]["source"]["version"], "Wrong version output")
        if fixture["name"] == "help":
            require(out.startswith(b"Usage:\n  bitwuzla ") and len(out) > 500, "Missing help output")
        write_error = record["write_error"]
        require(write_error is None or ((fixture["name"].startswith("syntax") or (runtime == "wasi" and fixture["name"] == "time-limit-boundary")) and write_error == ("Byte pipe closed" if runtime == "wasi" else "write EPIPE")), "Unexpected write error")
        for column in COLUMNS:
            value = record[column]
            require(row[column] == ("" if value is None else str(value)), f"CSV column differs: {column}")
        outputs[runtime, fixture["name"]] = (out, err)
    for fixture in cases:
        if "wasi" not in fixture:
            require(outputs["native", fixture["name"]] == outputs["wasi", fixture["name"]], "Native/WASI bytes differ")
    summary = json.loads((directory / "summary.json").read_bytes())
    require(summary["phase"] == setup["phase"], "Summary phase differs")
    require(summary["status"] == "pass" and summary["commit"] == setup["commit"] and summary["cases"] == len(cases) and summary["executions"] == len(matrix), "Invalid CLI summary")
    require(summary["csv_sha256"] == sha((directory / "results.csv").read_bytes()), "CLI summary CSV digest differs")
    require({file.name for file in directory.iterdir()} == expected_files, "Unexpected CLI evidence files")
    return {"status": "pass", "phase": setup["phase"], "rows": len(rows), "columns": len(COLUMNS)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--evidence-root", type=Path)
    parser.add_argument("--git-repo", type=Path, default=ROOT)
    args = parser.parse_args()
    print(json.dumps(audit(args.input, args.evidence_root, args.git_repo), sort_keys=True))
