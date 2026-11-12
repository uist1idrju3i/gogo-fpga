#!/usr/bin/env python3
"""Prepare one patched translation unit without changing the upstream checkout."""

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path


def digest(content):
    return hashlib.sha256(content).hexdigest()


def write_changed(path, content):
    if not path.exists() or path.read_bytes() != content:
        path.write_bytes(content)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--patch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--translation-unit", choices=("common/place/placer_heap.cc", "himbaechel/uarch/gowin/globals.cc"),
                        default="common/place/placer_heap.cc")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    destinations = (args.output.resolve(), args.output.with_suffix(".json").resolve())
    protected = (args.source.resolve(), args.patch.resolve())
    if destinations[0] == destinations[1] or any(
        destination in protected or any(
            destination.is_relative_to(root / directory) for directory in ("vendor", "third_party")
        )
        for destination in destinations
    ):
        raise SystemExit("The prepared source and metadata must not overwrite a source or patch")
    original = args.source.read_bytes()
    patch = args.patch.read_bytes()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="prepare-", dir=args.output.parent) as temporary:
        directory = Path(temporary)
        target = directory / args.translation_unit
        target.parent.mkdir(parents=True)
        target.write_bytes(original)
        patch_snapshot = directory / "input.patch"
        patch_snapshot.write_bytes(patch)
        result = subprocess.run(
            ["patch", "--batch", "--fuzz=0", "-p1", "-i", str(patch_snapshot)],
            cwd=directory, capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise SystemExit(f"nextpnr patch failed:\n{result.stdout}\n{result.stderr}")
        patched = target.read_bytes()
    if patched == original:
        raise SystemExit("nextpnr patch did not change the translation unit")
    if args.source.read_bytes() != original or args.patch.read_bytes() != patch:
        raise SystemExit("The source or patch changed during patch preparation")
    write_changed(args.output, patched)
    metadata = {
        "translation_unit": args.translation_unit,
        "source_sha256": digest(original),
        "patch": args.patch.name,
        "patch_sha256": digest(patch),
        "patched_source_sha256": digest(patched),
    }
    write_changed(args.output.with_suffix(".json"), (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode())


if __name__ == "__main__":
    main()
