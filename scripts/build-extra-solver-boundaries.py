#!/usr/bin/env python3
"""Build test-only upstream API probes from recorded Boolector diagnostic inputs."""

import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("solver_build", ROOT / "scripts/build-solver-probe.py")
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def build(args):
    directory = args.probe_build.resolve()
    raw = (directory / "metadata.json").read_bytes()
    source = json.loads(raw)
    if (source["status"], source["solver"], source["worktree_status"]) != ("built", "boolector", ""):
        raise ValueError("Expected a clean Boolector diagnostic build")
    expected = json.loads(BUILD.pin("formal-pins"))["boolector"]["commit"]
    if source["source"]["commit"] != expected:
        raise ValueError("Boolector source pin mismatch")
    script = subprocess.check_output(["git", "show", f'{source["base_commit"]}:scripts/build-solver-probe.py'], cwd=ROOT)
    if hashlib.sha256(script).hexdigest() != source["script_sha256"]:
        raise ValueError("Build driver provenance mismatch")
    for item in source["patches"]:
        if BUILD.digest(ROOT / item["path"]) != item["sha256"]:
            raise ValueError("Build patch mismatch")
    if BUILD.digest(directory / source["artifact"]["path"]) != source["artifact"]["sha256"]:
        raise ValueError("Solver artifact mismatch")
    output = args.out.absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Boundary output already exists")
    output.mkdir(parents=True)
    metadata = {"format": 1, "purpose": __doc__, "status": "error", "runtime": source["runtime"],
        "source_build": str(directory), "source_metadata_sha256": hashlib.sha256(raw).hexdigest(),
        "source_build_commit": source["base_commit"], "unpatched_ids": args.unpatched_ids,
        "script_sha256": BUILD.digest(Path(__file__)), "patches": [], "commands": [], "artifacts": {},
        "base_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "worktree_status": subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True),
        "started_unix": time.time()}
    environment = {key: value for key, value in os.environ.items() if key != "BTORAPITRACE"}
    environment.update(LC_ALL="C", TZ="UTC", SOURCE_DATE_EPOCH="0")

    def run(label, command, cwd=None):
        argv = [str(item) for item in command]
        record = {"label": label, "argv": argv, "cwd": str(cwd or output)}
        metadata["commands"].append(record)
        with (output / f"{label}.log").open("x") as log:
            log.write(shlex.join(argv) + "\n")
            log.flush()
            start = time.monotonic()
            result = subprocess.run(argv, cwd=cwd or output, env=environment,
                                    stdout=log, stderr=log, check=False)
            record.update(exit_code=result.returncode, elapsed_seconds=time.monotonic() - start,
                          log_sha256=BUILD.digest(output / f"{label}.log"))
        result.check_returncode()

    try:
        (output / Path(__file__).name).write_bytes(Path(__file__).read_bytes())
        harness = output / "extra-solver-boundary.c"
        harness.write_bytes((ROOT / "tests/synth/extra-solver-boundary.c").read_bytes())
        metadata["harness_sha256"] = BUILD.digest(harness)
        configure = next(item["argv"] for item in source["commands"] if item["label"] == "configure")

        def config(name):
            values = [item.split("=", 1)[1] for item in configure if item.startswith(f"-D{name}=")]
            if len(values) != 1:
                raise ValueError(f"Missing or ambiguous compiler configuration: {name}")
            return values[0]

        cc, cxx = config("CMAKE_C_COMPILER"), config("CMAKE_CXX_COMPILER")
        cflags = shlex.split(config("CMAKE_C_FLAGS"))
        links = shlex.split(config("CMAKE_EXE_LINKER_FLAGS"))
        metadata["compiler"] = subprocess.check_output([cc, "--version"], text=True)
        metadata["compiler_cxx"] = subprocess.check_output([cxx, "--version"], text=True)
        archive = directory / "btor2tools-source.tar"
        if BUILD.digest(archive) != source["dependencies"]["btor2tools"]["archive_sha256"]:
            raise ValueError("BTOR2 source archive mismatch")
        snapshot = output / archive.name
        snapshot.write_bytes(archive.read_bytes())
        btor = output / "btor2tools-source"
        btor.mkdir()
        with tarfile.open(fileobj=io.BytesIO(snapshot.read_bytes())) as entries:
            entries.extractall(btor, filter="data")
        if not args.unpatched_ids and source["runtime"] == "wasi":
            name = "btor2tools-wasi-ids.patch"
            if not any(item["path"] == f"patches/{name}" for item in source["patches"]):
                raise ValueError("Expected a solver build with the ID patch")
            BUILD.apply_source_patch(name, btor, output, metadata, run, "btor2tools-ids-patch")
        parser = btor / "src/btor2parser"
        run("compile-ids", [cc, *cflags, "-DPROBE_BTOR2_IDS", f"-I{parser}", f"-I{btor}/src",
                            harness, parser / "btor2parser.c", *links, "-o", output / "ids"])
        if not args.unpatched_ids:
            libraries = []
            for name in ("boolector", "cadical", "btor2parser"):
                item = source["static_libraries"][name]
                library = directory / item["path"]
                if BUILD.digest(library) != item["sha256"] or library.stat().st_size != item["bytes"]:
                    raise ValueError("Static library mismatch")
                libraries.append(library)
            obj = output / "trace.o"
            run("compile-trace", [cc, *cflags, "-DPROBE_BOOLECTOR_TRACE", f"-I{directory}/source/src",
                                  f"-I{directory}/objects/src", "-c", harness, "-o", obj])
            standard = shlex.split(config("CMAKE_CXX_STANDARD_LIBRARIES")) if source["runtime"] == "wasi" else []
            run("link-trace", [cxx, *[flag for flag in cflags if not flag.startswith("-std=")], obj,
                               *libraries, *links, *standard, "-lm", "-o", output / "trace"])
        for name in ("ids", "trace"):
            artifact = output / name
            if artifact.exists():
                metadata["artifacts"][name] = {"path": name, "bytes": artifact.stat().st_size,
                                               "sha256": BUILD.digest(artifact)}
        metadata["status"] = "built"
    except Exception as error:
        metadata["error"] = str(error)
        raise
    finally:
        metadata["elapsed_seconds"] = time.time() - metadata["started_unix"]
        (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--probe-build", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--unpatched-ids", action="store_true")
    build(parser.parse_args())
