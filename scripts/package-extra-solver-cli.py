#!/usr/bin/env python3
"""Bundle audited CLI repetitions and the complete build-evidence closure."""

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("cli_summary", Path(__file__).with_name("summarize-extra-solver-cli.py"))
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)


def package(prefix, output, published, extra=()):
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    worktree = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT, text=True)
    if worktree:
        raise ValueError("Evidence packaging requires a clean committed worktree")
    SUMMARY.summarize(prefix, published, check=True)
    files = set()

    def add(file):
        file = Path(file)
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Not a regular evidence file: {file}")
        file = file.resolve()
        file.relative_to(ROOT)
        files.add(file)

    builds = set()
    for series, count in (("aa", 2), ("formal", 5)):
        for repetition in range(1, count + 1):
            directory = Path(f"{prefix}-{series}-{repetition}")
            for file in directory.iterdir():
                add(file)
            setup = json.loads((directory / "setup.json").read_bytes())
            for option in ("--native", "--wasi", "--negative-wasi"):
                path = Path(setup["argv"][setup["argv"].index(option) + 1])
                builds.add(path if path.is_absolute() else Path(setup["repository"]) / path)
    for build in builds:
        metadata = json.loads((build / "metadata.json").read_bytes())
        for file in ("metadata.json", metadata["script_snapshot"], "meson-machine.ini", metadata["artifact"]["path"], *metadata["libraries"]):
            add(build / file)
        for command in metadata["commands"]:
            add(build / f"{command['label']}.log")
        for patch in metadata["patches"]:
            add(build / patch["snapshot"])
        if metadata["runtime"] == "wasi":
            add(build / "wasi-meson-compiler.py")
        for name in ("gmp", "mpfr"):
            info = metadata[name]
            add(build / f"{name}-{info['version']}.tar.xz")
            for file in info["licenses"]:
                add(build / f"{name}-source" / file)
            for file in info["headers"]:
                add(build / "dependencies/include" / file)
        for name in ("cadical", "symfpu"):
            wrap = metadata["wraps"][name]
            info = metadata["dependencies"][name]
            add(build / "source/subprojects" / f"{name}.wrap")
            add(build / (wrap["source_filename"] if name == "cadical" else "symfpu-source.tar"))
            staged = build / "source/subprojects" / (wrap["directory"] if name == "cadical" else "symfpu")
            for file in info["licenses"]:
                add(staged / file)
            for file in info["overlay"]:
                add(build / "source/subprojects/packagefiles" / name / file)
                add(staged / file)
    for file in (*SUMMARY.AUDIT.SOURCES, "scripts/summarize-extra-solver-cli.py", "scripts/package-extra-solver-cli.py"):
        add(ROOT / file)
    for series in ("aa", "formal"):
        add(Path(published) / f"S15-bitwuzla-cli-{series}.csv")
    for path in extra:
        path = Path(path)
        if path.is_dir():
            for file in path.rglob("*"):
                if file.is_file():
                    add(file)
        else:
            add(path)
    index = []
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(files):
            data = file.read_bytes()
            relative = file.relative_to(ROOT).as_posix()
            index.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            archive.writestr(relative, data)
        archive.writestr("manifest.json", json.dumps({"format": 1, "package_commit": commit, "files": index}, sort_keys=True, indent=2) + "\n")
    with zipfile.ZipFile(output) as archive:
        if len(archive.namelist()) != len(index) + 1 or set(archive.namelist()) != {item["path"] for item in index} | {"manifest.json"}:
            raise ValueError("Unexpected archive file set")
        for item in index:
            data = archive.read(item["path"])
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError(f"Archived bytes mismatch: {item['path']}")
        manifest_sha256 = hashlib.sha256(archive.read("manifest.json")).hexdigest()
    return {"archive": str(output), "files": len(index), "bytes": Path(output).stat().st_size,
            "sha256": hashlib.sha256(Path(output).read_bytes()).hexdigest(), "manifest_sha256": manifest_sha256}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--published", type=Path, default=ROOT / "docs/experiments")
    parser.add_argument("--extra", action="append", default=[], type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.prefix, args.out, args.published, args.extra), sort_keys=True))
