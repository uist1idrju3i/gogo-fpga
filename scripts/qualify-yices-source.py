#!/usr/bin/env python3
"""Rebuild the product solver from Git-free corresponding sources, retaining evidence."""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import runpy
import shutil
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    out = args.out.absolute()
    out.mkdir(parents=True, exist_ok=False)
    driver = runpy.run_path(str(ROOT / "scripts/build-formal-solvers.py"))
    reference = driver["read_bundle"](ROOT, driver["build_directory"](ROOT))
    source = out / "source"
    source.mkdir()
    files = ["RESEARCH.md", ".github/scripts/check-pins.py", "scripts/build-formal-solvers.py",
             "scripts/build-solver-probe.py", "scripts/prepare-formal-sources.py"]
    files += ["patches/" + name for name in driver["PATCHES"]]
    files += ["licenses/" + name for name in driver["licenses"](ROOT) if name.startswith("gmp-")]
    for name in files:
        target = source / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    snapshot = driver["source_snapshot"](ROOT)
    upstream = source / "vendor/yices2"
    upstream.mkdir(parents=True)
    archive = subprocess.check_output(["git", "-C", str(ROOT / "vendor/yices2"), "archive", snapshot["pin"]["commit"]])
    with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
        stream.extractall(upstream, filter="data")
    (upstream / ".gitcommit").write_text(snapshot["pin"]["commit"] + "\n")
    (source / driver["SNAPSHOT"]).write_bytes(driver["encoded"](snapshot))
    commit = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
    (source / "RELEASE-SOURCE.json").write_bytes(driver["encoded"]({"commit": commit}))
    gmp = reference["inputs"]["gmp"]["asset"]
    prepared = runpy.run_path(str(ROOT / "scripts/prepare-formal-sources.py"))
    prepared["prepare"](ROOT, out / "dependencies")
    (source / "vendor/formal-archives").mkdir()
    shutil.copyfile(out / "dependencies" / gmp, source / "vendor/formal-archives" / gmp)
    # Re-extract the verified SDK archive rather than reuse an installed compiler tree.
    (source / "build/cache").mkdir(parents=True)
    sdk_asset = reference["inputs"]["wasi_sdk"]["asset"]
    os.link(ROOT / "build/cache" / sdk_asset, source / "build/cache" / sdk_asset)
    guard = out / "guard"
    guard.mkdir()
    blocked = guard / "git"
    blocked.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$GIT_BLOCK_LOG"\nexit 98\n')
    blocked.chmod(0o755)
    attempts = out / "git-attempts.log"
    command = ["python3", str(source / "scripts/build-formal-solvers.py"), "build"]
    started = time.monotonic()
    with (out / "build.log").open("wb") as log:
        completed = subprocess.run(command, cwd=source, stdout=log, stderr=subprocess.STDOUT,
                                   env={**os.environ, "PATH": str(guard) + os.pathsep + os.environ["PATH"],
                                        "GIT_BLOCK_LOG": str(attempts), "BUILD_ROOT": str(source / "build")}, check=False)
    driver["require"](completed.returncode == 0, "Git-free solver build failed; see build.log")
    driver["require"](not attempts.exists(), "Git-free build attempted to invoke Git")
    rebuilt = driver["read_bundle"](source, source / "build/formal-solvers")
    driver["require"](rebuilt["inputs"] == reference["inputs"] and rebuilt["assets"][0] == reference["assets"][0],
                      "Git-free solver inputs or binary differ from the Git checkout build")
    def normalized_proof(file):
        text = file.read_text()
        for directory in ("build/cache", "vendor/formal-archives"):
            text = text.replace("${SOURCE_ROOT}/" + directory + "/" + gmp, "${GMP_SOURCE_ARCHIVE}")
        return json.loads(text)
    driver["require"](normalized_proof(source / "build/formal-solvers/yices2-build.json") ==
                      normalized_proof(driver["build_directory"](ROOT) / "yices2-build.json"),
                      "Git-free solver provenance differs beyond the GMP archive location")
    binary = (source / "build/formal-solvers/yices2.wasm").read_bytes()
    driver["require"](str(out).encode() not in binary and str(ROOT).encode() not in binary, "Build path leaked into WASM")
    results = {"commit": commit, "inputs": reference["inputs"], "binary": rebuilt["assets"][0],
               "host": platform.platform(), "cpus": os.cpu_count(), "elapsed_seconds": time.monotonic() - started,
               "git_attempts": 0, "binary_identical": True, "inputs_identical": True,
               "provenance_equivalent": True, "manifest_identical": rebuilt == reference,
               "log_sha256": hashlib.sha256((out / "build.log").read_bytes()).hexdigest()}
    (out / "results.json").write_bytes(driver["encoded"](results))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
