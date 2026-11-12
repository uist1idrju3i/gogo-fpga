#!/usr/bin/env python3
"""Build an isolated nextpnr diagnostic; never replace a shipped binary."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=Path("build/native/nextpnr"))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--patch", type=Path)
    parser.add_argument("--keep-vectorization", action="store_true")
    parser.add_argument("--fp-contract", choices=("off", "fast"))
    parser.add_argument("--march", choices=("x86-64", "x86-64-v3"))
    parser.add_argument("--translation-unit", choices=("common/place/placer_heap.cc", "common/route/router1.cc", "himbaechel/uarch/gowin/globals.cc"),
                        default="common/place/placer_heap.cc")
    args = parser.parse_args()
    build = args.build_dir.resolve()
    out = args.out.resolve()
    target = build / "himbaechel/uarch/gowin"
    cmake = target / "CMakeFiles/nextpnr-himbaechel-gowin.dir"
    flags_text = (cmake / "flags.make").read_text()
    flags = {}
    for line in flags_text.splitlines():
        if " = " in line:
            key, value = line.split(" = ", 1)
            flags[key] = shlex.split(value)
    link = shlex.split((cmake / "link.txt").read_text())
    if any(token in ("&&", ";", "|") for token in link):
        raise ValueError("Unsupported compound CMake link command")
    unit = Path(args.translation_unit)
    suffixes = tuple(f"/{name}.{extension}" for name in (str(unit), f"patched/{unit.name}", unit.name) for extension in ("o", "obj"))
    objects = [i for i, token in enumerate(link) if token.endswith(suffixes)]
    if len(objects) != 1 or link.count("-o") != 1:
        raise ValueError("Expected exactly one translation-unit object and output")
    cache = (build / "CMakeCache.txt").read_text().splitlines()
    homes = [line.split("=", 1)[1] for line in cache if line.startswith("CMAKE_HOME_DIRECTORY:INTERNAL=")]
    if len(homes) != 1:
        raise ValueError("Missing CMake source directory")
    source = Path(homes[0]) / unit
    original = (target / link[link.index("-o") + 1]).resolve()
    if not original.is_relative_to(build):
        raise ValueError("Unexpected original executable outside build directory")
    original_hash = sha256(original)
    original_object = target / link[objects[0]]
    out.mkdir()
    (out / "tmp").mkdir()
    (out / "share").symlink_to(build / "share", target_is_directory=True)
    patched = source
    if args.patch:
        patched = out / "source" / unit
        patched.parent.mkdir(parents=True)
        shutil.copyfile(source, patched)
        with (out / "patch.log").open("x") as log:
            subprocess.run(["patch", "--batch", "--fuzz=0", "-p1", "-d", str(out / "source"),
                            "-i", str(args.patch.resolve())], stdout=log, stderr=log, check=True)
    options = [] if args.keep_vectorization else ["-DEIGEN_DONT_VECTORIZE"]
    if args.fp_contract:
        options.append(f"-ffp-contract={args.fp_contract}")
    if args.march:
        options.append(f"-march={args.march}")
    target_flags = [token for token in link if token.startswith("--target=")]
    command = [link[0], *target_flags, *flags["CXX_DEFINES"], *flags["CXX_INCLUDES"], *flags["CXX_FLAGS"],
               *options, "-iquote", str(source.parent), "-o", str(out / f"{unit.stem}.o"), "-c", str(patched)]
    link[objects[0]] = str(out / f"{unit.stem}.o")
    executable = out / original.name
    link[link.index("-o") + 1] = str(executable)
    link = [f"-Wl,--dependency-file={out / 'link.d'}" if token.startswith("-Wl,--dependency-file=")
            else token for token in link]
    metadata = {"purpose": __doc__, "translation_unit": str(unit), "compile": command, "link": link,
                "source_sha256": sha256(source), "original_sha256": original_hash,
                "original_object_sha256": sha256(original_object),
                "flags_sha256": sha256(cmake / "flags.make"),
                "script_sha256": sha256(Path(__file__)),
                "patched_source_sha256": sha256(patched),
                "patch_sha256": sha256(args.patch) if args.patch else None,
                "compiler_version": subprocess.check_output([link[0], "--version"], text=True)}
    (out / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    env = {**os.environ, "TMPDIR": str(out / "tmp")}
    with (out / "compile.log").open("x") as log:
        subprocess.run(command, cwd=target, env=env, stdout=log, stderr=log, check=True)
    with (out / "link.log").open("x") as log:
        subprocess.run(link, cwd=target, env=env, stdout=log, stderr=log, check=True)
    if sha256(original) != original_hash:
        raise ValueError("The original binary changed during the diagnostic build")
    metadata["candidate_sha256"] = sha256(executable)
    (out / "result.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(metadata["candidate_sha256"])


if __name__ == "__main__":
    main()
