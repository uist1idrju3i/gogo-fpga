#!/usr/bin/env python3
"""Bundle measured S15 boundary bytes, logs and build provenance without source trees."""

import argparse
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
S15 = ROOT / "build/S15"


def main(output):
    files = set()

    def add(file):
        file = file.resolve(strict=True)
        if file.is_symlink() or not file.is_file():
            raise ValueError(f"Not a regular file: {file}")
        file.relative_to(ROOT)
        files.add(file)

    def add_directory(name):
        directory = S15 / name
        for item in directory.rglob("*"):
            if item.is_file() and not item.is_symlink() and "btor2tools-source" not in item.parts:
                add(item)
        add(S15 / f"{name}.log")

    for name in ("portability-native-01", "portability-wasi-01",
                 "boolector-native-e286c9f-01", "boolector-wasi-e286c9f-01"):
        directory = S15 / name
        info = json.loads((directory / "metadata.json").read_bytes())
        add(directory / "metadata.json")
        add(directory / info["script_snapshot"])
        for command in info["commands"]:
            add(directory / f"{command['label']}.log")
        for item in info["patches"]:
            add(directory / item["snapshot"])
        for item in [info["artifact"], *info.get("static_libraries", {}).values()]:
            add(directory / item["path"])
    for name in (
        "boundary-native-patched-preliminary-01", "boundary-wasi-patched-preliminary-01",
        "boundary-native-unpatched-preliminary-01", "boundary-wasi-unpatched-preliminary-01",
        "boundary-native-unpatched-preliminary-02", "boundary-wasi-unpatched-preliminary-02",
        "boundary-native-patched-formal-01", "boundary-wasi-patched-formal-01",
        "boundary-native-unpatched-formal-01", "boundary-wasi-unpatched-formal-01",
    ):
        add_directory(name)
    for name in ("boundary-patched-preliminary-01", "boundary-patched-preliminary-02",
                 "boundary-unpatched-preliminary-02", "boundary-unpatched-preliminary-03",
                 "boolector-cli-portability-preliminary-01"):
        add_directory(name)
    for label in ("AA-01", "AA-02", *(f"formal-{index:02}" for index in range(1, 6))):
        for kind in ("patched", "unpatched"):
            name = f"boundary-{kind}-{label}"
            add_directory(name)
            add(S15 / f"{name}-audit.log")
    for name in ("boundary-patched-preliminary-02-audit.log", "boundary-patched-preliminary-02-audit-2.log",
                 "boundary-patched-preliminary-02-audit-3.log", "boundary-unpatched-preliminary-03-audit.log",
                 "boundary-unpatched-preliminary-03-audit-2.log", "boundary-audit-unit-preliminary-01.log",
                 "boundary-protocol-before-formal.log", "boundary-web-before-formal.log",
                 "boundary-links-before-formal.log", "boundary-links-before-formal-2.log",
                 "boundary-jis-before-formal.log", "boundary-yomiyasu-before-formal.log"):
        add(S15 / name)
    for name in ("probe-extra-solver-boundaries.mjs", "audit-extra-solver-boundaries.py",
                 "package-extra-solver-boundaries.py", "summarize-extra-solver-boundaries.py"):
        add(ROOT / "scripts" / name)
    for name in ("S15-solver-boundaries-preliminary.csv", "S15-solver-boundaries-control-preliminary.csv",
                 "S15-solver-boundaries-formal.csv", "S15-solver-boundaries-aa.csv"):
        add(ROOT / "docs/experiments" / name)

    output.parent.mkdir(parents=True, exist_ok=True)
    index = []
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for file in sorted(files):
            data = file.read_bytes()
            relative = file.relative_to(ROOT).as_posix()
            index.append({"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            archive.writestr(relative, data)
        archive.writestr("manifest.json", json.dumps({"format": 1, "files": index}, sort_keys=True, indent=2) + "\n")
    with zipfile.ZipFile(output) as archive:
        if (len(archive.namelist()) != len(index) + 1 or
                set(archive.namelist()) != {item["path"] for item in index} | {"manifest.json"}):
            raise ValueError("Unexpected archive file set")
        for item in index:
            data = archive.read(item["path"])
            if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
                raise ValueError(f"Archived bytes mismatch: {item['path']}")
        manifest_sha256 = hashlib.sha256(archive.read("manifest.json")).hexdigest()
    print(json.dumps({"archive": str(output), "files": len(index), "bytes": output.stat().st_size,
                      "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                      "manifest_sha256": manifest_sha256}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    main(parser.parse_args().out)
