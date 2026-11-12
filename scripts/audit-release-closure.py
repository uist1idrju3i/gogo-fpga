#!/usr/bin/env python3
"""Audit a release against Git-free regeneration and its recorded revision."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tarfile
import tempfile
import zipfile


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def stream_digest(stream) -> str:
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        value.update(chunk)
    return value.hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def safe_path(name: str) -> None:
    path = PurePosixPath(name)
    require(bool(path.parts) and not path.is_absolute() and ".." not in path.parts
            and "\\" not in name and ".git" not in path.parts,
            f"Unsafe archive or asset path: {name}")


def assets(value):
    if isinstance(value, dict):
        if {"asset", "size", "sha256"} <= value.keys():
            yield value
        for child in value.values():
            yield from assets(child)
    elif isinstance(value, list):
        for child in value:
            yield from assets(child)


def files(directory: Path) -> set[str]:
    result = set()
    for file in directory.rglob("*"):
        require(not file.is_symlink(), f"Unexpected distribution symlink: {file}")
        if file.is_file():
            result.add(file.relative_to(directory).as_posix())
    return result


def git_bytes(root: Path, revision: str, relative: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), "show", f"{revision}:{relative}"])


def compare_git_archive(repository: Path, revision: str, destination: Path) -> None:
    with tempfile.TemporaryFile() as snapshot:
        subprocess.run(["git", "-C", str(repository), "archive", "--format=tar", revision],
                       stdout=snapshot, check=True)
        snapshot.seek(0)
        with tarfile.open(fileobj=snapshot) as archive:
            for member in archive:
                safe_path(member.name)
                local = destination / member.name
                if member.isfile():
                    require(local.is_file() and not local.is_symlink(), "Missing Git archive source file")
                    with archive.extractfile(member) as expected, local.open("rb") as actual:
                        require(stream_digest(expected) == stream_digest(actual), "Source Git archive mismatch")
                elif member.issym():
                    require(local.is_symlink() and str(local.readlink()) == member.linkname, "Source Git archive link mismatch")


def audit(root: Path, source: Path, generated: Path, version: str, revision: str) -> dict:
    require(bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._+-]*", version)), "Invalid release version")
    require(bool(re.fullmatch(r"[0-9a-f]{40}", revision)), "Expected full source revision")
    require(not (source / ".git").exists(), "Source must not contain Git metadata")
    formal_licenses = {}
    formal_source_licenses = {}
    gitmodules = subprocess.check_output(["git", "-C", str(root), "ls-tree", revision, ".gitmodules"])
    if gitmodules and b"path = vendor/sby" in git_bytes(root, revision, ".gitmodules"):
        spec = importlib.util.spec_from_file_location("formal_sources", root / "scripts/prepare-formal-sources.py")
        formal = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(formal)
        formal_archive = formal.archive_pin(root)
        archive_root = source / "vendor/formal-archives"
        formal_licenses = formal.verify_archive(archive_root / formal_archive["asset"], formal_archive)
        formal_source_licenses = formal.pin_checker(root).FORMAL_SOURCES
        require(json.loads((archive_root / "manifest.json").read_text()) == {"gmp": formal_archive},
                "Formal source manifest mismatch")
    metadata = json.loads((source / "RELEASE-SOURCE.json").read_text())
    require(metadata["commit"] == revision and metadata["version"] == version, "Release metadata mismatch")
    catalog_bytes = (root / "dist/libraries/catalog.json").read_bytes()
    entries = json.loads(catalog_bytes)["entries"]
    require(bool(entries) and len(entries) == len({entry["id"] for entry in entries}), "Empty or duplicate catalog")
    for location in [generated, source / "dist/libraries"]:
        require((location / "catalog.json").read_bytes() == catalog_bytes, "Catalog mismatch")
        require(files(location) == files(root / "dist/libraries"), "Library distribution paths mismatch")
    require((source / "libraries/source-manifest.json").read_bytes() == catalog_bytes, "Source manifest mismatch")
    verified = {}
    web_prefix = f"toolchain-web-{version}/"
    with zipfile.ZipFile(root / f"release/toolchain-web-{version}.zip") as web:
        members = web.infolist()
        names = [member.filename for member in members]
        require(len(names) == len(set(names)), "Duplicate Web ZIP member")
        for member in members:
            safe_path(member.filename)
            require(member.filename.startswith(web_prefix), "Unexpected Web ZIP prefix")
            require(member.file_size < 25 * 1024 * 1024, "Web asset exceeds static delivery limit")
        require(web.read(web_prefix + "libraries/catalog.json") == catalog_bytes, "Web ZIP catalog mismatch")
        for entry in entries:
            submodule = entry["submodule"]
            safe_path(submodule)
            pin = subprocess.check_output(
                ["git", "-C", str(root), "rev-parse", f"{revision}:{submodule}"], text=True).strip()
            require(entry["source"]["revision"] == pin, "Catalog revision mismatch")
            require((source / submodule / ".gitcommit").read_text().strip() == pin, "Source gitlink mismatch")
            require(bool(entry["license"]["files"]), "Missing library license")
            for asset in assets(entry):
                key = asset["asset"]
                safe_path(key)
                original = (root / "dist/libraries" / key).read_bytes()
                require(len(original) == asset["size"] and digest(original) == asset["sha256"], "Library asset hash mismatch")
                for location in [generated, source / "dist/libraries"]:
                    require((location / key).read_bytes() == original, "Regenerated library asset mismatch")
                require(web.read(web_prefix + "libraries/" + key) == original, "Web ZIP library asset mismatch")
                verified[key] = asset["sha256"]
        for name in ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
            expected = git_bytes(root, revision, name)
            require((source / name).read_bytes() == expected, f"Source notice mismatch: {name}")
            require(web.read(web_prefix + name) == expected, f"Web ZIP notice mismatch: {name}")
        for name, contents in formal_licenses.items():
            require(web.read(web_prefix + "licenses/gmp-" + name) == contents, "GMP ZIP license mismatch")
        for name, license_path in formal_source_licenses.items():
            expected = (source / "vendor" / name / license_path).read_bytes()
            require(bool(expected) and web.read(web_prefix + f"licenses/{name}-{license_path}") == expected,
                    "Formal source ZIP license mismatch")
        for location, prefix in [(root / "dist/surfer/licenses", "surfer/licenses/"), (root / "licenses", "licenses/")]:
            require(location.is_dir() and bool(files(location)), f"Missing license directory: {prefix}")
            for relative in files(location):
                expected = (location / relative).read_bytes()
                require(bool(expected) and web.read(web_prefix + prefix + relative) == expected, "License mismatch")
        for folder in ["synth", "pack", "iverilog", "surfer"]:
            location = root / "dist" / folder
            require(location.is_dir() and bool(files(location)), f"Missing tool distribution: {folder}")
            for relative in files(location):
                expected = (location / relative).read_bytes()
                require(web.read(web_prefix + folder + "/" + relative) == expected, "Tool distribution mismatch")
        for relative in files(root / "dist"):
            require(web.read(web_prefix + relative) == (root / "dist" / relative).read_bytes(),
                    f"Web distribution mismatch: {relative}")
        web_files = sum(not member.is_dir() for member in members)
    snapshot_files = 0
    gitlinks = 0
    tree = subprocess.check_output(["git", "-C", str(root), "ls-tree", "-r", "-z", revision])
    for record in tree.split(b"\0"):
        if not record:
            continue
        header, name = record.split(b"\t", 1)
        mode, kind, object_id = header.decode("ascii").split()
        relative = name.decode("utf-8")
        safe_path(relative)
        local = source / relative
        if kind == "commit":
            marker = local / ".gitcommit"
            if marker.is_file():
                require(marker.read_text().strip() == object_id, f"Source gitlink mismatch: {relative}")
            elif relative in metadata.get("submodule_shas", {}):
                require(metadata["submodule_shas"][relative] == object_id, f"Source metadata gitlink mismatch: {relative}")
            else:
                compare_git_archive(root / relative, object_id, local)
            gitlinks += 1
        elif mode == "120000":
            require(local.is_symlink() and str(local.readlink()).encode() == git_bytes(root, revision, relative),
                    f"Source snapshot link mismatch: {relative}")
            snapshot_files += 1
        else:
            require(local.is_file() and not local.is_symlink()
                    and local.read_bytes() == git_bytes(root, revision, relative), f"Source snapshot mismatch: {relative}")
            snapshot_files += 1
    with tarfile.open(root / f"release/toolchain-source-{version}.tar.gz", "r:gz") as archive:
        members = archive.getmembers()
        require(len(members) == len({member.name for member in members}), "Duplicate source archive member")
        for member in members:
            safe_path(member.name)
            prefix = f"toolchain-source-{version}/"
            require(member.name.startswith(prefix) or (member.isdir() and member.name == prefix[:-1]),
                    "Unexpected source archive prefix")
            if member.issym() or member.islnk():
                target = PurePosixPath(member.linkname)
                require(not target.is_absolute() and "\\" not in member.linkname, "Unsafe source link")
                resolved = posixpath.normpath(str(PurePosixPath(member.name).parent / target) if member.issym() else str(target))
                require(resolved.startswith(prefix), "Source link escapes archive root")
            if member.isfile():
                local = source.joinpath(*PurePosixPath(member.name).parts[1:])
                require(local.is_file() and not local.is_symlink()
                        and local.resolve().is_relative_to(source.resolve()), "Unsafe extracted source file")
                with archive.extractfile(member) as archived, local.open("rb") as extracted:
                    require(stream_digest(archived) == stream_digest(extracted),
                            f"Source archive content mismatch: {member.name}")
        source_files = sum(member.isfile() for member in members)
    return {
        "revision": revision, "archive_version": version,
        "library_entries": len(entries), "unique_library_assets": len(verified),
        "catalog_sha256": digest(catalog_bytes), "web_files": web_files, "source_files": source_files,
        "source_snapshot_files": snapshot_files, "source_gitlinks": gitlinks,
        "checks": [
            "Git-free source archive and safe member paths",
            "Library revision pins and .gitcommit files",
            "Every root snapshot file and direct submodule gitlink matches the recorded Git revision",
            "Catalog and every declared source/license asset byte-identical in root, Git-free regeneration, source-built dist, and Web ZIP",
            "Exact NOTICE/LICENSE/README/third-party notices and Surfer/root licenses in distribution",
            "All synth/pack/Icarus/Surfer distribution bytes identical to Web ZIP",
            "Every dist file byte-identical to Web ZIP and every source archive file byte-identical to extracted source",
            "Every Web ZIP member smaller than 25 MiB",
        ],
        "cached_inputs": "Previously verified native/WASM binaries and npm dependencies reused for Git-free Web assembly; compilers were not rebuilt from this archive.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--generated-libraries", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        require(not args.output.exists(), "Refusing to overwrite audit output")
        report = audit(args.root, args.source, args.generated_libraries, args.version, args.revision)
        with args.output.open("x", encoding="utf-8") as output:
            output.write(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        print(json.dumps(report, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError,
            tarfile.TarError, zipfile.BadZipFile) as error:
        parser.exit(1, f"release-closure: {error}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
