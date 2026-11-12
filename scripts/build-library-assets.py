#!/usr/bin/env python3
"""Build the static library catalog from pinned submodule objects."""

from __future__ import annotations

import argparse
import configparser
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath


ROOT = Path(__file__).resolve().parents[1]
SLUG = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
LANGUAGES = {"verilog", "vhdl", "systemverilog", "scala"}
KINDS = {"library", "cpu", "verification"}
BOARD_STATES = {"confirmed", "capacity-exceeded", "frontend-unsupported", "unverified"}
ENTRY_KEYS = {
    "id", "label", "kind", "language", "submodule", "license", "deprecated",
    "status", "reason", "components",
}
COMPONENT_KEYS = {
    "id", "label", "sources", "data", "dependencies", "includeDirectories",
    "defines", "boards",
}


def git(root: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)


def relative_path(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or not re.fullmatch(r"[A-Za-z0-9._/-]+", value)
        or value.startswith("/")
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError(f"Invalid library path: {value!r}")
    return value


def checked_keys(value: dict, allowed: set[str], required: set[str]) -> None:
    if not isinstance(value, dict) or set(value) - allowed or required - set(value):
        raise ValueError(f"Invalid catalog fields; expected {sorted(required)}")


def validate_catalog(catalog: dict) -> list[dict]:
    checked_keys(catalog, {"formatVersion", "entries"}, {"formatVersion", "entries"})
    if type(catalog["formatVersion"]) is not int or catalog["formatVersion"] != 1 or not isinstance(catalog["entries"], list):
        raise ValueError("Unsupported library catalog format")
    ids: set[str] = set()
    for entry in catalog["entries"]:
        checked_keys(entry, ENTRY_KEYS, ENTRY_KEYS)
        identifier = entry["id"]
        if not isinstance(identifier, str) or not SLUG.fullmatch(identifier) or identifier in ids:
            raise ValueError("Invalid or duplicate library id")
        ids.add(identifier)
        if entry["submodule"] != f"third_party/{identifier}":
            raise ValueError(f"{identifier}: submodule must match library id")
        if entry["kind"] not in KINDS or entry["language"] not in LANGUAGES:
            raise ValueError(f"{identifier}: invalid kind or language")
        if entry["status"] not in {"unverified", "unsupported", "frontend-unsupported", "available"}:
            raise ValueError(f"{identifier}: invalid status")
        if not isinstance(entry["deprecated"], bool):
            raise ValueError(f"{identifier}: invalid maintenance flag")
        if any(not isinstance(entry[key], str) or not entry[key].strip() for key in ("label", "reason")):
            raise ValueError(f"{identifier}: label and reason are required")
        license_info = entry["license"]
        checked_keys(license_info, {"expression", "files", "note"}, {"expression", "files"})
        if not isinstance(license_info["expression"], str) or not license_info["expression"].strip():
            raise ValueError(f"{identifier}: missing license expression")
        if not isinstance(license_info["files"], list) or not license_info["files"]:
            raise ValueError(f"{identifier}: missing license texts")
        for path in license_info["files"]:
            relative_path(path)
        if not isinstance(entry["components"], list):
            raise ValueError(f"{identifier}: components must be a list")
        if entry["status"] == "unsupported" and entry["components"]:
            raise ValueError(f"{identifier}: unsupported library cannot expose components")
        if entry["status"] == "available" and not entry["components"]:
            raise ValueError(f"{identifier}: available library has no components")
        component_ids: set[str] = set()
        for component in entry["components"]:
            checked_keys(component, COMPONENT_KEYS | {"parameters"}, COMPONENT_KEYS)
            component_id = component["id"]
            if not isinstance(component_id, str) or not SLUG.fullmatch(component_id) or component_id in component_ids:
                raise ValueError(f"{identifier}: invalid or duplicate component id")
            component_ids.add(component_id)
            if not isinstance(component["label"], str) or not component["label"].strip():
                raise ValueError(f"{identifier}: missing component label")
            for key in ("sources", "data", "dependencies", "includeDirectories"):
                if not isinstance(component[key], list):
                    raise ValueError(f"{identifier}: {key} must be a list")
            if not component["sources"]:
                raise ValueError(f"{identifier}: component has no sources")
            parameters = component.get("parameters", {})
            if not isinstance(parameters, dict) or any(
                not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
                or not isinstance(value, str) or not value.strip() or len(value) > 1024
                or any(ord(char) < 32 for char in value)
                for name, value in parameters.items()
            ):
                raise ValueError(f"{identifier}: invalid parameter metadata")
            paths: set[str] = set()
            for source in component["sources"]:
                checked_keys(source, {"path", "language", "library"}, {"path", "language"})
                path = relative_path(source["path"])
                if path in paths or source["language"] not in {"verilog", "vhdl"}:
                    raise ValueError(f"{identifier}: invalid or duplicate source")
                paths.add(path)
                suffixes = {"verilog": {".v", ".vh"}, "vhdl": {".vhd", ".vhdl"}}
                if PurePosixPath(path).suffix not in suffixes[source["language"]]:
                    raise ValueError(f"{identifier}: source extension does not match language")
                if source["language"] == "vhdl" and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", source.get("library", "")):
                    raise ValueError(f"{identifier}: missing VHDL library name")
                if source["language"] == "verilog" and "library" in source:
                    raise ValueError(f"{identifier}: Verilog source cannot name a VHDL library")
            for path in component["data"] + component["includeDirectories"]:
                relative_path(path)
            for dependency in component["dependencies"]:
                if not isinstance(dependency, str) or len(dependency.split("/")) != 2 or any(not SLUG.fullmatch(part) for part in dependency.split("/")):
                    raise ValueError(f"{identifier}: invalid component dependency")
            if not isinstance(component["defines"], dict) or any(
                not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                or not isinstance(value, str)
                or any(char in value for char in "\r\n\x00")
                for key, value in component["defines"].items()
            ):
                raise ValueError(f"{identifier}: invalid Verilog defines")
            if not isinstance(component["boards"], dict) or not component["boards"] or any(
                not SLUG.fullmatch(key) or state not in BOARD_STATES
                for key, state in component["boards"].items()
            ):
                raise ValueError(f"{identifier}: invalid board states")
        if entry["status"] == "available" and not any(
            "confirmed" in component["boards"].values() for component in entry["components"]
        ):
            raise ValueError(f"{identifier}: available library has no confirmed board")
        if entry["status"] == "frontend-unsupported" and (
            not entry["components"] or any(
                state != "frontend-unsupported"
                for component in entry["components"] for state in component["boards"].values()
            )
        ):
            raise ValueError(f"{identifier}: frontend-unsupported library must retain only unsupported boards")
    components = {f'{entry["id"]}/{component["id"]}': component for entry in catalog["entries"] for component in entry["components"]}
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name not in components:
            raise ValueError(f"Unknown component dependency: {name}")
        if name in visiting:
            raise ValueError(f"Cyclic component dependency: {name}")
        if name in visited:
            return
        visiting.add(name)
        for dependency in components[name]["dependencies"]:
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for name in components:
        visit(name)
    return catalog["entries"]


def submodules(root: Path) -> dict[str, dict]:
    config = configparser.ConfigParser(interpolation=None)
    config.read(root / ".gitmodules", encoding="utf-8")
    modules: dict[str, dict] = {}
    for section in config.sections():
        values = dict(config[section])
        path = values.get("path", "")
        if not path.startswith("third_party/"):
            continue
        relative_path(path)
        if path in modules or values.get("shallow") != "true" or not values.get("branch"):
            raise ValueError(f"{path}: duplicate module or missing shallow/branch setting")
        if not values.get("url", "").startswith("https://"):
            raise ValueError(f"{path}: expected HTTPS upstream URL")
        modules[path] = values
    return modules


def pinned_revision(root: Path, path: str) -> str:
    line = git(root, "ls-files", "--stage", "-z", "--", path)
    entries = [entry for entry in line.split(b"\0") if entry]
    if len(entries) != 1:
        raise ValueError(f"{path}: expected exactly one gitlink")
    metadata, name = entries[0].decode().split("\t", 1)
    mode, revision, stage = metadata.split()
    if name != path or mode != "160000" or stage != "0" or not FULL_SHA.fullmatch(revision):
        raise ValueError(f"{path}: invalid or unresolved gitlink")
    if git(root / path, "rev-parse", "HEAD").decode().strip() != revision:
        raise ValueError(f"{path}: checkout differs from pinned gitlink")
    return revision


def pinned_file(root: Path, revision: str, path: str, provenance: list[dict] | None = None) -> bytes:
    relative_path(path)
    parts = PurePosixPath(path).parts
    for index in range(len(parts)):
        prefix = "/".join(parts[:index + 1])
        line = git(root, "ls-tree", "-z", revision, "--", prefix)
        if not line:
            raise ValueError(f"Missing pinned source: {path}")
        metadata, name = line.rstrip(b"\0").decode().split("\t", 1)
        mode, kind, blob = metadata.split()
        if name != prefix:
            raise ValueError(f"Unexpected pinned source: {path}")
        if mode == "160000" and kind == "commit" and index + 1 < len(parts):
            nested = root / prefix
            if any((root / Path(*parts[:i + 1])).is_symlink() for i in range(index + 1)):
                raise ValueError(f"Nested submodule symlink is not allowed: {prefix}")
            if not (nested / ".git").exists():
                raise ValueError(f"Missing initialized nested submodule: {prefix}")
            if git(nested, "rev-parse", "HEAD").decode().strip() != blob:
                raise ValueError(f"{prefix}: nested checkout differs from pinned gitlink")
            config = configparser.ConfigParser(interpolation=None)
            config.read_string(git(root, "show", f"{revision}:.gitmodules").decode())
            urls = [section.get("url", "") for section in config.values() if section.get("path") == prefix]
            if len(urls) != 1 or not re.fullmatch(r"https://[^\s]+", urls[0]):
                raise ValueError(f"Invalid pinned nested upstream URL: {prefix}")
            if provenance is not None:
                parent = provenance[-1]["path"] + "/" if provenance else ""
                provenance.append({"path": parent + prefix, "url": urls[0], "revision": blob})
            return pinned_file(nested, blob, "/".join(parts[index + 1:]), provenance)
        if index + 1 == len(parts) and mode in {"100644", "100755"} and kind == "blob":
            return git(root, "cat-file", "blob", blob)
        if mode != "040000" or kind != "tree":
            raise ValueError(f"Not a regular pinned file: {path}")
    raise ValueError(f"Not a regular pinned file: {path}")


def archive_catalog(root: Path) -> dict[str, dict] | None:
    if (root / ".git").exists():
        return None
    manifest = json.loads((root / "libraries/source-manifest.json").read_text(encoding="utf-8"))
    if manifest.get("formatVersion") != 1 or not isinstance(manifest.get("entries"), list):
        raise ValueError("Invalid source archive library manifest")
    entries = {entry["id"]: entry for entry in manifest["entries"]}
    if len(entries) != len(manifest["entries"]):
        raise ValueError("Duplicate source archive library id")
    return entries


def archive_path(root: Path, path: str) -> Path:
    relative_path(path)
    current = root
    for part in path.split("/"):
        current = current / part
        if current.is_symlink():
            raise ValueError(f"Source archive symlink is not allowed: {path}")
    return current


def archive_file(root: Path, module: str, entry: dict, path: str, provenance: list[dict] | None = None) -> bytes:
    records = entry["license"]["files"] + [
        asset for component in entry["components"]
        for asset in component["sources"] + component["data"]
    ]
    matches = [asset for asset in records if asset["path"] == path]
    if not matches or any(
        any(asset.get(key) != matches[0].get(key) for key in ("asset", "size", "sha256", "provenance"))
        for asset in matches[1:]
    ):
        raise ValueError(f"Missing or conflicting source archive record: {module}/{path}")
    origins = matches[0].get("provenance", [])
    if not isinstance(origins, list):
        raise ValueError(f"Invalid nested provenance: {module}/{path}")
    parent = ""
    for origin in origins:
        checked_keys(origin, {"path", "url", "revision"}, {"path", "url", "revision"})
        prefix = relative_path(origin["path"]) + "/"
        if not prefix.startswith(parent) or prefix == parent or not path.startswith(prefix) or not isinstance(origin["url"], str) or not re.fullmatch(
            r"https://[^\s]+", origin["url"]
        ) or not isinstance(origin["revision"], str) or not FULL_SHA.fullmatch(origin["revision"]):
            raise ValueError(f"Invalid nested provenance: {module}/{path}")
        parent = prefix
    if provenance is not None:
        provenance.extend(origins)
    data = archive_path(root, f"{module}/{path}").read_bytes()
    if matches[0]["size"] != len(data) or matches[0]["sha256"] != hashlib.sha256(data).hexdigest():
        raise ValueError(f"Source archive hash mismatch: {module}/{path}")
    return data


def copy_nested_assets(root: Path, manifest: dict, output: Path) -> None:
    files: dict[Path, bytes] = {}
    for entry in manifest["entries"]:
        assets = entry["license"]["files"] + [
            asset for component in entry["components"] for asset in component["sources"] + component["data"]
        ]
        nested_assets = [asset for asset in assets if asset.get("provenance")]
        if not nested_assets:
            continue
        module = relative_path(entry["submodule"])
        revision = pinned_revision(root, module)
        if revision != entry["source"]["revision"]:
            raise ValueError(f"Nested source archive revision mismatch: {module}")
        for asset in nested_assets:
            provenance: list[dict] = []
            data = pinned_file(root / module, revision, asset["path"], provenance)
            if provenance != asset["provenance"] or len(data) != asset["size"] or hashlib.sha256(data).hexdigest() != asset["sha256"]:
                raise ValueError(f"Nested source archive provenance or hash mismatch: {module}/{asset['path']}")
            destination = archive_path(output, f"{module}/{asset['path']}")
            if destination.exists() and destination.read_bytes() != data:
                raise ValueError(f"Cannot overwrite nested source archive file: {destination}")
            files[destination] = data
    for destination, data in files.items():
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)


def build_catalog(root: Path, catalog: dict, output: Path) -> dict:
    entries = validate_catalog(catalog)
    modules = submodules(root)
    if set(modules) != {entry["submodule"] for entry in entries}:
        raise ValueError("Catalog and third_party submodules do not match")
    if output.exists():
        raise ValueError(f"Refusing to overwrite existing library assets: {output}")
    manifest = json.loads(json.dumps(catalog))
    archived = archive_catalog(root)
    if archived is not None and set(archived) != {entry["id"] for entry in entries}:
        raise ValueError("Source archive library catalog does not match")
    assets: dict[str, bytes] = {}
    for entry in manifest["entries"]:
        module = modules[entry["submodule"]]
        archived_entry = archived[entry["id"]] if archived is not None else None
        if archived_entry is None:
            revision = pinned_revision(root, entry["submodule"])
        else:
            revision = archived_entry["source"]["revision"]
            marker = archive_path(root, entry["submodule"] + "/.gitcommit")
            if not FULL_SHA.fullmatch(revision) or marker.read_text(encoding="ascii").strip() != revision:
                raise ValueError(f'{entry["id"]}: source archive revision mismatch')
            if archived_entry["source"]["url"] != module["url"]:
                raise ValueError(f'{entry["id"]}: source archive upstream URL mismatch')
        entry["source"] = {"url": module["url"], "revision": revision}

        def asset(path: str) -> dict:
            provenance: list[dict] = []
            data = (
                pinned_file(root / entry["submodule"], revision, path, provenance) if archived_entry is None
                else archive_file(root, entry["submodule"], archived_entry, path, provenance)
            )
            name = f'{entry["id"]}/{path}'
            assets[name] = data
            record = {"path": path, "asset": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            if provenance:
                record["provenance"] = provenance
            return record

        entry["license"]["files"] = [asset(path) for path in entry["license"]["files"]]
        for component in entry["components"]:
            component["sources"] = [{**source, **asset(source["path"])} for source in component["sources"]]
            component["data"] = [asset(path) for path in component["data"]]
    output.mkdir(parents=True)
    for path, content in assets.items():
        destination = output / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    (output / "catalog.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        catalog = json.loads((args.root / "libraries/catalog.json").read_text(encoding="utf-8"))
        manifest = build_catalog(args.root, catalog, args.output)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.error(str(error))
    print(f'Built {len(manifest["entries"])} pinned library catalog entries in {args.output}')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
