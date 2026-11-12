#!/usr/bin/env python3
"""Stage the pinned GMP archive and its original licenses for source releases."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import posixpath
import shutil
import tarfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
LICENSE_FILES = ("COPYING", "COPYINGv2", "COPYINGv3", "COPYING.LESSERv3")


def pin_checker(root: Path):
    spec = importlib.util.spec_from_file_location("pins", root / ".github/scripts/check-pins.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def archive_pin(root: Path) -> dict[str, str]:
    return pin_checker(root).parse_archive_pin((root / "RESEARCH.md").read_text(), "gmp")


def verify_archive(archive: Path, pin: dict[str, str]) -> dict[str, bytes]:
    if archive.is_symlink() or not archive.is_file():
        raise ValueError("Missing or linked GMP source archive")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != pin["sha256"]:
        raise ValueError("GMP source archive hash mismatch")
    prefix = f"gmp-{pin['version']}"
    seen = set()
    licenses = {}

    def check_path(name: str) -> str:
        path = PurePosixPath(name)
        if (not path.parts or path.is_absolute() or ".." in path.parts or ".git" in path.parts
                or "\\" in name or path.parts[0] != prefix):
            raise ValueError(f"Unsafe GMP source path: {name}")
        return path.as_posix()

    with tarfile.open(archive, "r:xz") as source:
        for member in source:
            name = check_path(member.name)
            if name in seen:
                raise ValueError("Duplicate GMP source archive member")
            seen.add(name)
            if member.issym() or member.islnk():
                target = member.linkname
                if member.issym():
                    target = posixpath.join(posixpath.dirname(name), target)
                check_path(posixpath.normpath(target))
            elif not (member.isfile() or member.isdir()):
                raise ValueError("Unsupported GMP source archive member")
            if name in {f"{prefix}/{item}" for item in LICENSE_FILES}:
                if not member.isfile() or not 0 < member.size < 1024 * 1024:
                    raise ValueError("Invalid GMP license member")
                licenses[PurePosixPath(name).name] = source.extractfile(member).read()
    if set(licenses) != set(LICENSE_FILES):
        raise ValueError("Missing GMP source license")
    return licenses


def prepare(root: Path, output: Path) -> None:
    if output.exists() or output.is_symlink():
        raise ValueError("Formal source output already exists")
    pin = archive_pin(root)
    archive = root / "vendor/formal-archives" / pin["asset"]
    if not (archive.exists() or archive.is_symlink()):
        archive = root / "build/cache" / pin["asset"]
        if not archive.exists():
            archive.parent.mkdir(parents=True, exist_ok=True)
            request = urllib.request.Request(pin["url"], headers={"User-Agent": "toolchain-source-build"})
            with urllib.request.urlopen(request, timeout=60) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != pin["sha256"]:
                raise ValueError("Downloaded GMP source archive hash mismatch")
            with archive.open("xb") as destination:
                destination.write(data)
    licenses = verify_archive(archive, pin)
    output.mkdir(parents=True)
    (output / "licenses").mkdir()
    for name, contents in licenses.items():
        (output / "licenses" / f"gmp-{name}").write_bytes(contents)
    shutil.copyfile(archive, output / pin["asset"])
    (output / "manifest.json").write_text(json.dumps({"gmp": pin}, indent=2, sort_keys=True) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.root.resolve(), args.output.absolute())


if __name__ == "__main__":
    main()
