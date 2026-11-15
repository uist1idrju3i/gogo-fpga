#!/usr/bin/env python3
"""Build, verify, and stage pinned product Yices2 assets and original notices."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import runpy
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 25 * 1024 * 1024
PATCHES = ("yices2/reproducible-version.patch", "yices2/unsupported-wasi-alarm.patch")
SNAPSHOT = "vendor/formal-yices2-source.json"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def encoded(data):
    return (json.dumps(data, indent=2, sort_keys=True) + "\n").encode()


def build_directory(root):
    directory = Path(os.environ.get("BUILD_ROOT", root / "build"))
    return (directory if directory.is_absolute() else root / directory) / "formal-solvers"


def source_snapshot(root):
    upstream = root / "vendor/yices2"
    checker = runpy.run_path(str(root / ".github/scripts/check-pins.py"))
    pin = checker["parse_formal_pins"]((root / "RESEARCH.md").read_text())["yices2"]
    files = {}
    if (upstream / ".git").exists():
        require(subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip() == pin["commit"],
                "Yices2 source pin mismatch")
        require(not subprocess.check_output(["git", "-C", str(upstream), "status", "--porcelain"]), "Modified Yices2 source")
        archive = subprocess.check_output(["git", "-C", str(upstream), "archive", pin["commit"]])
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            for member in stream:
                if member.isdir():
                    continue
                require(member.isfile() or member.issym(), "Unsupported Yices2 source type")
                files[member.name] = ({"symlink": member.linkname} if member.issym() else
                                      {"sha256": sha256(stream.extractfile(member).read())})
        return {"format_version": 1, "pin": pin, "files": files}
    document = json.loads((root / SNAPSHOT).read_text())
    require(type(document.get("format_version")) is int and document["format_version"] == 1 and
            document.get("pin") == pin and isinstance(document.get("files"), dict) and document["files"],
            "Invalid archived Yices2 provenance")
    require((upstream / ".gitcommit").read_text().strip() == pin["commit"], "Archived Yices2 pin mismatch")
    for file in upstream.rglob("*"):
        path = file.relative_to(upstream).as_posix()
        if path == ".gitcommit" or (file.is_dir() and not file.is_symlink()):
            continue
        require(file.is_symlink() or file.is_file(), "Unsupported archived Yices2 source type")
        files[path] = {"symlink": os.readlink(file)} if file.is_symlink() else {"sha256": sha256(file.read_bytes())}
    require(files == document["files"], "Archived Yices2 source inventory mismatch")
    return document


def inputs(root):
    checker = runpy.run_path(str(root / ".github/scripts/check-pins.py"))
    research = (root / "RESEARCH.md").read_text()
    snapshot = source_snapshot(root)
    return {"source": snapshot["pin"], "source_snapshot_sha256": sha256(encoded(snapshot)),
            "gmp": checker["parse_archive_pin"](research, "gmp"), "wasi_sdk": checker["parse_wasi_sdk_pin"](research),
            "patches": {name: sha256((root / "patches" / name).read_bytes()) for name in PATCHES},
            "scripts": {name: sha256((root / "scripts" / name).read_bytes()) for name in
                        ("build-formal-solvers.py", "build-solver-probe.py", "prepare-formal-sources.py")},
            "licenses": {name: sha256(data) for name, data in licenses(root).items()},
            "source_date_epoch": "0", "reproducible_paths": True, "solver": "yices2", "command": "yices-smt2", "smtbmc": "yices"}


def read_bundle(root, directory):
    require(directory.is_dir() and not directory.is_symlink(), "Missing product solver build")
    require(not (directory / "manifest.json").is_symlink(), "Linked product solver manifest")
    raw = (directory / "manifest.json").read_bytes()
    require(len(raw) <= 256 * 1024, "Oversized solver manifest")
    manifest = json.loads(raw)
    require(type(manifest.get("format_version")) is int and manifest["format_version"] == 1 and
            manifest.get("inputs") == inputs(root), "Product solver build inputs changed")
    entries = manifest.get("assets")
    require(isinstance(entries, list) and len(entries) == 2, "Invalid solver asset inventory")
    seen = set()
    for entry in entries:
        require(isinstance(entry, dict) and entry.get("path") in ("yices2.wasm", "yices2-build.json") and
                entry["path"] not in seen and set(entry) == {"path", "size", "sha256"}, "Invalid solver asset path")
        seen.add(entry["path"])
        file = directory / entry["path"]
        require(not file.is_symlink() and file.is_file() and type(entry.get("size")) is int and
                0 < entry["size"] < LIMIT, "Invalid solver asset size or type")
        data = file.read_bytes()
        require(len(data) == entry["size"] and sha256(data) == entry["sha256"], "Solver asset identity mismatch")
        if file.suffix == ".wasm":
            require(data[:8] == b"\x00asm\x01\x00\x00\x00", "Invalid product solver WebAssembly")
            check = subprocess.run(["node", "--input-type=module", "-e",
                                    "import {readFileSync} from 'node:fs'; process.exit(WebAssembly.validate(readFileSync(process.argv[1])) ? 0 : 1)",
                                    str(file)], capture_output=True, check=False)
            require(check.returncode == 0, "Invalid product solver WebAssembly module")
    info = json.loads((directory / "yices2-build.json").read_bytes())
    require(info.get("inputs") == manifest["inputs"] and info.get("binary") == entries[0] and
            info.get("gmp_library_sha256") and info.get("commands"), "Invalid solver build provenance")
    return manifest


def licenses(root):
    data = {"yices2-LICENSE.txt": (root / "vendor/yices2/LICENSE.txt").read_bytes()}
    data.update({f"gmp-{name}": (root / "licenses" / f"gmp-{name}").read_bytes() for name in
                 ("COPYING", "COPYINGv2", "COPYINGv3", "COPYING.LESSERv3")})
    require(all(data.values()), "Empty solver license")
    return data


def stage(root, directory, web):
    manifest = read_bundle(root, directory)
    destination = web / "formal/solvers"
    require(destination.resolve() == destination.absolute() and
            (web / "licenses").resolve() == (web / "licenses").absolute(), "Linked solver distribution directory")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ["manifest.json", *[entry["path"] for entry in manifest["assets"]]]:
        require(not (destination / name).is_symlink(), "Linked solver distribution file")
        shutil.copyfile(directory / name, destination / name)
    (web / "licenses").mkdir(parents=True, exist_ok=True)
    for name, contents in licenses(root).items():
        require(not (web / "licenses" / name).is_symlink(), "Linked solver distribution license")
        (web / "licenses" / name).write_bytes(contents)


def ensure_sdk(root, pin):
    archive = root / "build/cache" / pin["asset"]
    require(not archive.is_symlink(), "Linked WASI SDK archive")
    if not archive.exists():
        archive.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=archive.parent, delete=False) as stream:
            temporary = Path(stream.name)
            try:
                request = urllib.request.Request(pin["url"], headers={"User-Agent": "gogo-fpga-source-build"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    shutil.copyfileobj(response, stream)
                stream.flush()
                require(sha256(temporary.read_bytes()) == pin["sha256"], "Downloaded WASI SDK hash mismatch")
                temporary.rename(archive)
            finally:
                temporary.unlink(missing_ok=True)
    require(sha256(archive.read_bytes()) == pin["sha256"], "WASI SDK archive hash mismatch")
    directory = root / "build" / pin["asset"].removesuffix(".tar.gz")
    require(not directory.is_symlink(), "Linked WASI SDK directory")
    if not directory.exists():
        with tempfile.TemporaryDirectory(prefix="wasi-sdk-", dir=root / "build") as temporary:
            with tarfile.open(archive, "r:gz") as source:
                source.extractall(temporary, filter="data")
            shutil.move(str(Path(temporary) / directory.name), directory)
    require((directory / "bin/clang").is_file(), "Missing pinned WASI compiler")


def build(root, output, jobs):
    recipe = inputs(root)
    if output.exists():
        require(not output.is_symlink() and not (output / "manifest.json").is_symlink(), "Linked solver build")
        previous = (output / "manifest.json").read_bytes()
        require(len(previous) <= 256 * 1024, "Oversized cached solver manifest")
        if json.loads(previous).get("inputs") == recipe:
            read_bundle(root, output)
            return
        # Preserve previous evidence when a legitimate recipe change requires rebuilding.
        preserved = Path(tempfile.mkdtemp(prefix=output.name + "-previous-", dir=output.parent))
        output.rename(preserved / "bundle")
    require(not output.is_symlink() and jobs > 0, "Invalid solver output or job count")
    output.parent.mkdir(parents=True, exist_ok=True)
    ensure_sdk(root, recipe["wasi_sdk"])
    with tempfile.TemporaryDirectory(prefix="yices2-", dir=output.parent) as temporary:
        work = Path(temporary)
        helper = runpy.run_path(str(root / "scripts/prepare-formal-sources.py"))
        helper["prepare"](root, work / "dependencies")
        for name, contents in licenses(root).items():
            if name.startswith("gmp-"):
                require((work / "dependencies/licenses" / name).read_bytes() == contents, "GMP original notice mismatch")
        probe = work / "probe"
        command = ["python3", str(root / "scripts/build-solver-probe.py"), "--solver", "yices2", "--runtime", "wasi",
                   "--out", str(probe), "--jobs", str(jobs), "--reproducible-paths"]
        for patch in PATCHES:
            command += ["--patch", str(root / "patches" / patch)]
        subprocess.run(command, cwd=root, env={**os.environ, "SOURCE_DATE_EPOCH": "0"}, check=True)
        metadata = json.loads((probe / "metadata.json").read_text())
        require(metadata["status"] == "built" and metadata["source"] == recipe["source"], "Unsuccessful product solver build")
        data = (probe / metadata["artifact"]["path"]).read_bytes()
        require(len(data) == metadata["artifact"]["bytes"] and sha256(data) == metadata["artifact"]["sha256"], "Solver build hash mismatch")
        binary = {"path": "yices2.wasm", "size": len(data), "sha256": sha256(data)}
        # Keep commands portable; the private diagnostic output retains unabridged logs.
        sdk = str(root / "build" / recipe["wasi_sdk"]["asset"].removesuffix(".tar.gz"))
        def normalize(value):
            return str(value).replace(sdk, "${WASI_SDK}").replace(str(probe), "${SOLVER_BUILD}").replace(str(root), "${SOURCE_ROOT}")
        commands = [{"argv": [normalize(value) for value in entry["argv"]], "cwd": normalize(entry["cwd"]),
                     "environment": {name: normalize(value) for name, value in entry["environment"].items()}}
                    for entry in metadata["commands"]]
        info = {"inputs": recipe, "binary": binary, "compiler": metadata["compiler"].splitlines()[0],
                "gmp_library_sha256": metadata["gmp"]["library_sha256"], "commands": commands}
        bundle = work / "bundle"
        bundle.mkdir()
        (bundle / "yices2.wasm").write_bytes(data)
        (bundle / "yices2-build.json").write_bytes(encoded(info))
        proof = (bundle / "yices2-build.json").read_bytes()
        manifest = {"format_version": 1, "inputs": recipe, "assets": [binary,
                    {"path": "yices2-build.json", "size": len(proof), "sha256": sha256(proof)}]}
        (bundle / "manifest.json").write_bytes(encoded(manifest))
        read_bundle(root, bundle)
        # Publish the cache only after every source and output identity passes.
        shutil.move(str(probe), str(bundle / "private-build"))
        bundle.rename(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("build", "verify", "stage", "snapshot"))
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--web", type=Path)
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    args = parser.parse_args()
    root = args.root.resolve()
    output = args.out.absolute() if args.out else build_directory(root)
    if args.action == "build":
        build(root, output, args.jobs)
    elif args.action == "verify":
        read_bundle(root, output)
    elif args.action == "snapshot":
        require(args.out is not None, "Snapshot output is required")
        with output.open("xb") as stream:
            stream.write(encoded(source_snapshot(root)))
    else:
        require(args.web is not None, "Web root is required")
        stage(root, output, args.web.absolute())
