#!/usr/bin/env python3
"""Stage pinned upstream Python and the process-only SMTIO patch."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args])


def build(root, output):
    output.mkdir()
    origins = {}
    pins = {}
    archive = None
    if not (root / ".git").exists():
        archive = json.loads((root / "vendor/formal-python-sources.json").read_text())
        if (not isinstance(archive, dict) or type(archive.get("format_version")) is not int or
                archive["format_version"] != 1 or not isinstance(archive.get("pins"), dict) or
                set(archive["pins"]) != {"yosys", "sby", "click"} or
                not all(isinstance(pin, str) and re.fullmatch("[0-9a-f]{40}", pin) for pin in archive["pins"].values()) or
                not isinstance(archive.get("origins"), dict)):
            raise ValueError("Invalid archived formal Python provenance")
    for name, prefix, destination, license_file in [
        ("yosys", "backends/smt2/", "", "COPYING"),
        ("sby", "sbysrc/", "", "COPYING"),
        ("click", "src/click/", "click/", "LICENSE.txt"),
    ]:
        module = root / "vendor" / name
        if archive is None:
            tree = git(root, "ls-tree", "HEAD", f"vendor/{name}").decode().split()
            if len(tree) != 4 or tree[:2] != ["160000", "commit"]:
                raise ValueError("Missing pinned formal Python source")
            commit = tree[2]
            paths = git(module, "ls-tree", "-r", "--name-only", commit, prefix).decode().splitlines()
        else:
            commit = archive["pins"][name]
            paths = sorted(path.relative_to(module).as_posix() for path in (module / prefix).rglob("*.py"))
        pins[name] = commit
        for source in [p for p in paths if p.endswith(".py")] + [license_file]:
            target = f"licenses/{name}-{license_file}" if source == license_file else destination + source.removeprefix(prefix)
            file = output / target
            if file.exists() or not target or ".." in Path(target).parts:
                raise ValueError("Duplicate or unsafe formal Python path")
            if archive is None:
                data = git(module, "show", f"{commit}:{source}")
            else:
                original = module / source
                if original.resolve() != original:
                    raise ValueError("Linked archived formal Python source")
                data = original.read_bytes()
            origin = {"submodule": name, "source": source, "original_sha256": hashlib.sha256(data).hexdigest()}
            if archive is not None and archive["origins"].get(target) != origin:
                raise ValueError("Archived formal Python source identity mismatch")
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(data)
            origins[target] = origin
    if archive is not None and archive["origins"] != origins:
        raise ValueError("Archived formal Python source inventory mismatch")
    patch = root / "patches/yosys-smtio-process.patch"
    patches = {}
    for name in ("yosys-smtio-process.patch", "sby-process.patch"):
        source = root / "patches" / name
        subprocess.run(["patch", "--batch", "--fuzz=0", "--no-backup-if-mismatch", "-p1", "-i", str(source)],
                       cwd=output, capture_output=True, check=True)
        patches[name] = hashlib.sha256(source.read_bytes()).hexdigest()
    for name in ("formal_process.py", "formal_trace.py"):
        adapter = root / "web" / name
        (output / name).write_bytes(adapter.read_bytes())
    files = sorted(p for p in output.rglob("*") if p.is_file())
    if not 0 < len(files) <= 256 or sum(p.stat().st_size for p in files) > 32 * 1024 * 1024:
        raise ValueError("Formal Python bundle exceeds worker limits")
    manifest = {"format_version": 1, "pins": pins, "patch_sha256": hashlib.sha256(patch.read_bytes()).hexdigest(), "patches": patches,
        "origins": origins, "assets": [{"path": p.relative_to(output).as_posix(), "size": p.stat().st_size,
        "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]}
    encoded = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > 256 * 1024:
        raise ValueError("Formal Python manifest exceeds loader limits")
    (output / "manifest.json").write_bytes(encoded)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.root.resolve(), args.out.resolve())
