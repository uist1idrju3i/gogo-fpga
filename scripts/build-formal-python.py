#!/usr/bin/env python3
"""Stage pinned upstream Python and the process-only SMTIO patch."""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def build(root, output):
    output.mkdir()
    origins = {}
    pins = {}
    for name, prefix, destination, license_file in [
        ("yosys", "backends/smt2/", "", "COPYING"),
        ("sby", "sbysrc/", "", "COPYING"),
        ("click", "src/click/", "click/", "LICENSE.txt"),
    ]:
        module = root / "vendor" / name
        tree = git(root, "ls-tree", "HEAD", f"vendor/{name}").decode().split()
        if len(tree) != 4 or tree[:2] != ["160000", "commit"]:
            raise ValueError("Missing pinned formal Python source")
        commit = tree[2]
        pins[name] = commit
        paths = git(module, "ls-tree", "-r", "--name-only", commit, prefix).decode().splitlines()
        for source in [p for p in paths if p.endswith(".py")] + [license_file]:
            target = f"licenses/{name}-{license_file}" if source == license_file else destination + source.removeprefix(prefix)
            file = output / target
            if file.exists() or not target or ".." in Path(target).parts:
                raise ValueError("Duplicate or unsafe formal Python path")
            data = git(module, "show", f"{commit}:{source}")
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            origins[target] = {"submodule": name, "source": source, "original_sha256": hashlib.sha256(data).hexdigest()}
    patch = root / "patches/yosys-smtio-process.patch"
    patches = {}
    for name in ("yosys-smtio-process.patch", "sby-process.patch"):
        source = root / "patches" / name
        subprocess.run(["patch", "--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-i", str(source)], cwd=output, check=True)
        patches[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    for name in ("formal_process.py", "formal_trace.py"):
        adapter = root / "web" / name
        (output / name).write_bytes(adapter.read_bytes())
    files = sorted(p for p in output.rglob("*") if p.is_file())
    manifest = {"format_version": 1, "pins": pins, "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "patches": patches,
        "origins": origins, "assets": [{"path": p.relative_to(output).as_posix(), "size": p.stat().st_size,
        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.root.resolve(), args.out.resolve())
