#!/usr/bin/env python3
import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys


SALT = "build-cache-v1"
COMPONENTS = {
    "emsdk": ["build/emsdk-*"],
    "synth-sdk": ["build/cache/", "build/wasi-sdk-*"],
    "synth": ["build/wasi/yosys/yosys.wasm", "build/wasi/yosys/share/", "build/wasi/yosys/build-info.json"],
    "synth-native": ["build/native/yosys", "build/native/yosys-abc", "build/native/share/", "build/native/build-info.json"],
    "nextpnr-inputs": ["build/cache/", "build/deps/", "build/wasi-sdk-*"],
    "nextpnr": ["build/wasi/nextpnr/nextpnr-himbaechel-gowin.wasm", "build/wasi/nextpnr/share/", "build/wasi/nextpnr/build-info.json",
                "build/native/nextpnr/nextpnr-himbaechel-gowin", "build/native/nextpnr/share/", "build/native/nextpnr/build-info.json"],
    "ghdl-inputs": ["build/cache/ghdl-wasm/", "build/cache/ghdl-host-packages/", "build/wasi-sdk-*"],
    "ghdl": ["build/ghdl-wasm/", "build/ghdl-native/"],
    "iverilog-inputs": ["build/cache/wasi-sdk-*", "build/wasi-sdk-*"],
    "iverilog": ["build/iverilog-wasm/output/", "build/iverilog-native/output/", "build/iverilog-wasm/build-info.json", "build/iverilog-native/build-info.json"],
    "surfer-inputs": ["build/surfer/target/"],
    "surfer": ["build/surfer/dist/"],
    "flasher": ["build/jspi-pthread/openFPGALoader.mjs", "build/jspi-pthread/openFPGALoader.wasm", "build/jspi-pthread/build-info.json"],
    "decoders": ["build/wasi/decoders/"],
    "fixtures": ["build/fixtures/*.fs"],
    "pack-inputs": ["build/cache/pack/"],
}
INPUTS = {name for name in COMPONENTS if name.endswith("-inputs")} | {"emsdk", "synth-sdk"}
ENV_PREFIXES = ("WASI_", "DECODER_", "GHDL_", "SURFER_", "EMSDK_", "CMAKE_", "PACK_", "BUILD_", "RUST")
ENV_NAMES = {"CC", "CXX", "AR", "CFLAGS", "CXXFLAGS", "LDFLAGS", "SOURCE_DATE_EPOCH", "JOBS", "NODE_OPTIONS"}


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def key(root, component, environ):
    host = {name: environ.get(name, "") for name in ("RUNNER_OS", "RUNNER_ARCH", "ImageOS", "ImageVersion")}
    if not all(host.values()):
        raise ValueError("Runner OS, architecture and image version are required")
    files = {}
    for raw in git(root, "ls-files", "-z").split(b"\0"):
        if not raw:
            continue
        name = raw.decode()
        if (name.startswith(("scripts/", "patches/", ".github/", "tests/fixtures/")) or
            name in {"RESEARCH.md", ".gitmodules", ".nvmrc", "package.json", "package-lock.json",
                     "requirements-nextpnr.txt", "THIRD_PARTY_NOTICES.md", "LICENSE", "web/lib/boards.mjs"}):
            path = root / name
            if path.is_file() and not path.is_symlink():
                files[name] = digest(path)
            else:
                raise ValueError(f"Missing or non-regular cache input: {name}")
    if not files:
        raise ValueError("No cache inputs found")
    gitlinks = [line.decode() for line in git(root, "ls-tree", "-r", "-z", "HEAD").split(b"\0") if line.startswith(b"160000 ")]
    if not gitlinks:
        raise ValueError("No pinned submodules found")
    environment = {name: value for name, value in environ.items() if name in ENV_NAMES or name.startswith(ENV_PREFIXES)}
    packages = subprocess.check_output(["dpkg-query", "-W", "-f=${Package}=${Version}\n"], text=True)
    inputs = {"salt": SALT, "component": component, "host": host, "files": files, "workspace": str(root.resolve()),
              "gitlinks": gitlinks, "environment": environment, "packages": packages}
    if component == "flasher":
        inputs["source_date_epoch"] = git(root, "show", "-s", "--format=%ct", "HEAD").decode().strip()
    return f"{SALT}-{component}-{hashlib.sha256(encoded(inputs)).hexdigest()}"


def manifest_path(root, component):
    return root / "build/.ci-cache" / f"{component}.json"


def tree(root, component):
    entries = {}

    def visit(path):
        relative = path.relative_to(root).as_posix()
        info = path.lstat()
        if path.is_symlink():
            target = os.readlink(path)
            if component not in INPUTS and not path.resolve(strict=True).is_relative_to(root):
                raise ValueError(f"Output symlink escapes workspace: {relative}")
            entries[relative] = {"link": target}
        elif path.is_dir():
            entries[relative] = {"directory": stat.S_IMODE(info.st_mode)}
            for child in sorted(path.iterdir()):
                visit(child)
        elif path.is_file():
            entries[relative] = {"sha256": digest(path), "size": info.st_size, "mode": stat.S_IMODE(info.st_mode)}
        else:
            raise ValueError(f"Unsupported cache entry: {relative}")

    for pattern in COMPONENTS[component]:
        matches = sorted(glob.glob(str(root / pattern.rstrip("/"))))
        if not matches and component not in INPUTS:
            raise ValueError(f"Required cache output is missing: {pattern}")
        for match in matches:
            path = Path(match)
            # Ancestors must not redirect traversal into a different tree.
            if any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
                raise ValueError(f"Symlink ancestor: {path}")
            visit(path)
    if not any("sha256" in entry for entry in entries.values()):
        raise ValueError("Cache has no regular files")
    if component not in INPUTS:
        for name, entry in entries.items():
            if "link" in entry and (root / name).resolve(strict=True).relative_to(root).as_posix() not in entries:
                raise ValueError(f"Output symlink target is not cached: {name}")
    return entries


def seal(root, component, cache_key):
    path = manifest_path(root, component)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded({"key": cache_key, "entries": tree(root, component)}) + b"\n")
    print(f"Cache sealed: {component}")


def check(root, component, cache_key):
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise ValueError(f"Duplicate manifest key: {name}")
            result[name] = value
        return result

    def reject_constant(value):
        raise ValueError(f"Invalid JSON constant: {value}")

    metadata = json.loads(manifest_path(root, component).read_text(),
                          object_pairs_hook=unique, parse_constant=reject_constant)
    if metadata != {"key": cache_key, "entries": tree(root, component)}:
        raise ValueError(f"Cache integrity mismatch: {component}")
    print(f"Cache integrity verified: {component}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("key", "seal", "check"))
    parser.add_argument("component", choices=COMPONENTS)
    parser.add_argument("--key")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    try:
        if args.action == "key":
            value = key(root, args.component, os.environ)
            print(f"key={value}\npaths<<CI_CACHE_PATHS")
            print("\n".join(COMPONENTS[args.component]))
            print(f"build/.ci-cache/{args.component}.json\nCI_CACHE_PATHS")
        else:
            if not args.key or not re.fullmatch(re.escape(f"{SALT}-{args.component}-") + r"[0-9a-f]{64}", args.key):
                raise ValueError("Invalid cache key")
            {"seal": seal, "check": check}[args.action](root, args.component, args.key)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"Build cache: ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
