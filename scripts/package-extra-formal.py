#!/usr/bin/env python3
"""Deduplicate and restore byte-complete S15 formal campaign evidence."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
HEX = re.compile(r"[0-9a-f]{64}\Z")
MAX_OBJECT = 256 * 1024 * 1024
MAX_ARCHIVE = 2 * 1024 * 1024 * 1024
MAX_LOGICAL = 16 * 1024 * 1024 * 1024
MAX_MANIFEST = 64 * 1024 * 1024
AUDITORS = ("measure-extra-formal.py", "audit-formal-python.py", "audit-formal-sby.py",
            "audit-formal-controls.py", "sby-artifact-audit.py", "formal-solver-audit.py")
TRACE_AUDITORS = ("measure-formal-trace.py", "audit-formal-trace.py", "audit-formal-sby.py",
                  "sby-artifact-audit.py", "formal-solver-audit.py", "negative-formal-trace.py")
REPLAY_AUDITORS = ("measure-smt-replay.py", "audit-smt-replay.py", "negative-smt-replay.py", "audit-formal-trace.py",
                   "audit-formal-sby.py", "sby-artifact-audit.py", "formal-solver-audit.py")
VHDL_REPLAY_AUDITORS = ("measure-smt-vhdl-replay.py", "audit-smt-vhdl-replay.py", "negative-smt-vhdl-replay.py",
                        "audit-smt-replay.py", "audit-formal-trace.py", "audit-formal-sby.py", "sby-artifact-audit.py",
                        "formal-solver-audit.py")


def campaign_sources(plan):
    kind = plan.get("kind")
    require(kind in [None, "formal-trace-v1", "smt-replay-v1", "smt-vhdl-replay-v1"], "unknown campaign kind")
    if kind == "smt-vhdl-replay-v1":
        return ["scripts/" + name for name in VHDL_REPLAY_AUDITORS] + ["vendor/yosys/backends/smt2/smtio.py"]
    if kind == "smt-replay-v1":
        return ["scripts/" + name for name in REPLAY_AUDITORS] + ["vendor/yosys/backends/smt2/smtio.py"]
    if kind == "formal-trace-v1":
        return ["scripts/" + name for name in TRACE_AUDITORS] + ["vendor/yosys/backends/smt2/smtio.py"]
    return ["scripts/" + name for name in AUDITORS]


def require(value, message):
    if not value:
        raise ValueError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            require(key not in result, "duplicate manifest key")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False, "nonfinite manifest number"))


def safe_path(name):
    require(type(name) is str and name and "\\" not in name and "\0" not in name and ":" not in name, "invalid archive path")
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name and ".." not in path.parts and "." not in path.parts, "unsafe archive path")
    require("__pycache__" not in path.parts and path.suffix not in [".pyc", ".pyo"], "cached bytecode evidence")
    return path


def audited_campaign(directory):
    plan = strict_json((directory / "plan.json").read_bytes())
    sources = campaign_sources(plan)
    runner = directory / "snapshots" / sources[0]
    require(runner.is_file() and not runner.is_symlink(), "missing captured campaign runner")
    for name in sources:
        path = directory / "snapshots" / name
        require(path.is_file() and not path.is_symlink() and digest(path.read_bytes()) == digest((ROOT / name).read_bytes()),
                "trusted campaign auditor before execution")
    with tempfile.TemporaryDirectory(prefix="formal-audit-cache-") as cache:
        result = subprocess.run([sys.executable, "-I", "-B", "-X", "pycache_prefix=" + cache, str(runner), "--audit-only", "--out", str(directory)], cwd=ROOT,
                                capture_output=True, text=True, timeout=300)
    require(result.returncode == 0, "campaign audit failed: " + result.stderr[-2000:])
    report = strict_json(result.stdout)
    require(report["status"] == "pass" and report["commit"] == strict_json((directory / "plan.json").read_bytes())["commit"], "campaign report identity")
    return report


def collect(sources):
    paths = []
    for source in sources:
        source = Path(source).absolute()
        require(source.exists() and not source.is_symlink(), "missing or linked evidence source")
        candidates = source.rglob("*") if source.is_dir() else [source]
        for path in candidates:
            if path.is_dir() and not path.is_symlink():
                continue
            require(path.is_file(), "unsupported evidence entry")
            target = path.resolve(strict=True)
            target.relative_to(ROOT)
            safe_path(path.relative_to(ROOT).as_posix())
            paths.append((path, target))
    names = [path.relative_to(ROOT).as_posix() for path, _ in paths]
    require(len(names) == len(set(names)), "duplicate evidence")
    return sorted(paths, key=lambda pair: pair[0].relative_to(ROOT).as_posix())


def package(directory, output, extras=()):
    directory, output = Path(directory), Path(output)
    require(not directory.is_symlink(), "linked campaign directory")
    directory = directory.resolve(strict=True)
    directory.relative_to(ROOT)
    require(directory.is_dir() and not directory.is_symlink() and not output.exists(), "campaign or output path")
    report = audited_campaign(directory)
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    require(not subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True), "changed packaging checkout")
    files, objects, logical = [], {}, 0
    included = collect([directory, *extras])
    require(included, "missing evidence")
    extra_paths = sorted(path.relative_to(ROOT).as_posix() for path, _ in collect(extras))
    for path, target in included:
        data = target.read_bytes()
        require(len(data) <= MAX_OBJECT, "oversized evidence object")
        sha = digest(data)
        require(sha not in objects or objects[sha] == data, "SHA-256 collision")
        objects[sha] = data
        logical += len(data)
        require(logical <= MAX_LOGICAL, "oversized evidence tree")
        files.append({"path": path.relative_to(ROOT).as_posix(), "sha256": sha, "bytes": len(data),
                      "mode": 0o755 if target.stat().st_mode & stat.S_IXUSR else 0o644})
    require(sum(map(len, objects.values())) <= MAX_ARCHIVE, "oversized archive objects")
    manifest = {"format": 1, "campaign": directory.relative_to(ROOT).as_posix(), "extraPaths": extra_paths,
                "measurementCommit": report["commit"],
                "packageCommit": commit, "files": files}
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for sha, data in sorted(objects.items()):
            archive.writestr("objects/" + sha, data)
        archive.writestr("manifest.json", json.dumps(manifest, sort_keys=True, ensure_ascii=True, allow_nan=False) + "\n")
    validate(output)
    return {"archive": str(output), "files": len(files), "objects": len(objects), "bytes": output.stat().st_size,
            "sha256": digest(output.read_bytes()), "manifestSha256": digest(json.dumps(manifest, sort_keys=True, ensure_ascii=True).encode() + b"\n")}


def stage(sources, output):
    output = Path(output).absolute()
    output.relative_to(ROOT)
    require(sources and not output.exists() and output.resolve() == output, "missing sources or unsafe staging destination")
    entries, links, clones = [], [], []
    for source in sources:
        source = Path(source).absolute()
        source.relative_to(ROOT)
        require(source.exists() and source.resolve() == source and source not in output.parents and source != output, "unsafe staging source")
        for path in source.rglob("*") if source.is_dir() else [source]:
            if path.is_dir() and not path.is_symlink():
                continue
            require(path.is_file(), "unsupported staging entry")
            name = path.relative_to(ROOT).as_posix()
            safe_path(name)
            if path.is_symlink():
                metadata = path.parent.parent / "metadata.json"
                require(not metadata.is_symlink() and path.stat().st_size <= MAX_OBJECT, "unsafe launcher metadata or binary size")
                meta = strict_json(metadata.read_bytes())
                commands = meta.get("solverCommands")
                if commands is None:
                    commands = {solver: probe["command"] for solver, probe in meta["probes"].items()}
                sha = digest(path.read_bytes())
                verified = any(path.parent.name == solver + "-bin" and command["path"] == str(path)
                               and command["sha256"] == sha for solver, command in commands.items())
                if verified:
                    links.append({"path": name, "sha256": sha})
                else:
                    clone = None
                    if path.parent.parent.name == "mutated-evidence":
                        for solver, command in commands.items():
                            if path.parent.name != solver + "-bin":
                                continue
                            try:
                                original = Path(command["path"])
                                relative = original.relative_to(ROOT)
                                verified_clone = (original.is_absolute() and original.parent.name == path.parent.name
                                                  and original.name == path.name and original.is_symlink()
                                                  and os.readlink(original) == os.readlink(path)
                                                  and command["sha256"] == sha)
                            except (KeyError, OSError, TypeError, ValueError):
                                continue
                            if verified_clone:
                                clone = {"path": name, "launcher": relative.as_posix(), "sha256": sha}
                                break
                    require(clone is not None, "unverified launcher symlink")
                    clones.append(clone)
            entries.append((path, name))
    require(len(entries) == len({name for _, name in entries}), "overlapping staging sources")
    output.mkdir()
    objects = {}
    for path, name in entries:
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        key = (digest(path.read_bytes()), stat.S_IMODE(path.stat().st_mode))
        if key in objects:
            os.link(objects[key], target)
        else:
            shutil.copy2(path, target, follow_symlinks=True)
            objects[key] = target
    report = {"sources": [str(Path(source).absolute().relative_to(ROOT)) for source in sources], "files": len(entries),
              "materializedLaunchers": links, "materializedCloneLaunchers": clones}
    (output / "staging.json").write_text(json.dumps(report, sort_keys=True) + "\n")
    return report


def validate(archive):
    with zipfile.ZipFile(archive) as data:
        names = data.namelist()
        require(len(names) == len(set(names)) and "manifest.json" in names, "duplicate or absent archive member")
        require(data.getinfo("manifest.json").file_size <= MAX_MANIFEST, "oversized archive manifest")
        manifest = strict_json(data.read("manifest.json"))
        require(type(manifest) is dict and set(manifest) == {"format", "campaign", "extraPaths", "measurementCommit", "packageCommit", "files"}
                and type(manifest.get("format")) is int and manifest["format"] == 1,
                "unsupported archive format")
        campaign = safe_path(manifest["campaign"])
        require(type(manifest["extraPaths"]) is list and all(type(name) is str for name in manifest["extraPaths"]), "extra path set")
        extra_paths = set(manifest["extraPaths"])
        require(len(extra_paths) == len(manifest["extraPaths"]) and all(safe_path(name) for name in extra_paths), "unsafe extra paths")
        require(type(manifest["measurementCommit"]) is str and re.fullmatch(r"[0-9a-f]{40}", manifest["measurementCommit"]), "measurement commit")
        require(type(manifest["packageCommit"]) is str and re.fullmatch(r"[0-9a-f]{40}", manifest["packageCommit"]), "package commit")
        require(type(manifest["files"]) is list and manifest["files"], "missing archive files")
        objects, paths, size = set(), set(), 0
        for entry in manifest["files"]:
            require(type(entry) is dict and set(entry) == {"path", "sha256", "bytes", "mode"}, "manifest file columns")
            name = safe_path(entry["path"])
            require(str(name).startswith(str(campaign) + "/") or str(name) in extra_paths, "evidence outside campaign")
            require(entry["path"] not in paths and HEX.fullmatch(entry["sha256"]), "duplicate or invalid evidence hash")
            paths.add(entry["path"])
            require(type(entry["bytes"]) is int and 0 <= entry["bytes"] <= MAX_OBJECT and
                    type(entry["mode"]) is int and entry["mode"] in [0o644, 0o755],
                    "evidence size or mode")
            size += entry["bytes"]
            require(size <= MAX_LOGICAL, "expanded evidence limit")
            objects.add(entry["sha256"])
        require(extra_paths <= paths and {"objects/" + sha for sha in objects} | {"manifest.json"} == set(names), "unexpected or missing object")
        require(all(data.getinfo("objects/" + item["sha256"]).file_size == item["bytes"] for item in manifest["files"]), "manifest object size")
        require(sum(data.getinfo("objects/" + sha).file_size for sha in objects) <= MAX_ARCHIVE, "archive object limit")
        for sha in objects:
            info = data.getinfo("objects/" + sha)
            require(info.file_size <= MAX_OBJECT and digest(data.read(info)) == sha, "archived object bytes")
        plan = next((item for item in manifest["files"] if item["path"] == str(campaign) + "/plan.json"), None)
        require(plan is not None, "missing campaign plan")
        for name in campaign_sources(strict_json(data.read("objects/" + plan["sha256"]))):
            runner = next((item for item in manifest["files"] if item["path"] == str(campaign) + "/snapshots/" + name), None)
            require(runner is not None and runner["sha256"] == digest((ROOT / name).read_bytes()), "trusted campaign auditor")
        return manifest


def restore(archive, destination):
    manifest = validate(archive)
    destination = Path(destination).resolve()
    destination.mkdir()
    objects = {}
    with zipfile.ZipFile(archive) as data:
        for item in manifest["files"]:
            path = destination / item["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            key = (item["sha256"], item["mode"])
            if key in objects:
                os.link(objects[key], path)
            else:
                with path.open("xb") as stream:
                    stream.write(data.read("objects/" + item["sha256"]))
                objects[key] = path
            path.chmod(item["mode"])
            require(path.stat().st_size == item["bytes"] and digest(path.read_bytes()) == item["sha256"], "restored file bytes")
    report = audited_campaign(destination / manifest["campaign"])
    return {"status": "pass", "files": len(manifest["files"]), "commit": report["commit"],
            "archiveSha256": digest(Path(archive).read_bytes()), "manifestSha256": digest(json.dumps(manifest, sort_keys=True, ensure_ascii=True).encode() + b"\n")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign")
    parser.add_argument("--output", required=True)
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--restore", action="store_true")
    parser.add_argument("--stage", action="store_true")
    options = parser.parse_args()
    require(not (options.restore and options.stage), "conflicting archive operations")
    result = stage(options.include, options.output) if options.stage else restore(options.output, options.campaign) if options.restore else package(options.campaign, options.output, options.include)
    print(json.dumps(result, sort_keys=True, allow_nan=False))
