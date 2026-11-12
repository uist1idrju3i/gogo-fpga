#!/usr/bin/env python3
"""Collect license metadata and notices for Surfer's resolved WASM dependencies."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


def crate_license_files(package: dict[str, object]) -> list[Path]:
    manifest = Path(str(package["manifest_path"]))
    crate_dir = manifest.parent
    files = [
        path
        for path in crate_dir.iterdir()
        if path.is_file() and path.name.upper().startswith(("LICENSE", "COPYING", "NOTICE"))
    ]
    license_file = package.get("license_file")
    if license_file:
        candidate = Path(str(license_file))
        if not candidate.is_absolute():
            candidate = crate_dir / candidate
        if candidate.is_file():
            files.append(candidate)
    return sorted(set(files), key=lambda path: path.name)


def markdown_cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    source = args.source.resolve()
    output = args.output.resolve()
    if not (source / "Cargo.lock").is_file() or not (source / "surfer/Cargo.toml").is_file():
        fail(f"Surfer source or Cargo.lock is missing under {source}")
    if output == source or source in output.parents:
        fail("License output must be outside the Surfer source tree")

    command = [
        "cargo",
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        "wasm32-unknown-unknown",
        "--features",
        "surfer/accesskit",
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=source,
            check=True,
            capture_output=True,
            text=True,
        )
        metadata = json.loads(completed.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        fail(f"cargo metadata failed: {error}")

    packages = {package["id"]: package for package in metadata["packages"]}
    roots = [
        package
        for package in metadata["packages"]
        if package["name"] == "surfer"
        and Path(package["manifest_path"]).resolve() == (source / "surfer/Cargo.toml").resolve()
    ]
    if len(roots) != 1:
        fail(f"Expected one Surfer root package, found {len(roots)}")
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    root_id = roots[0]["id"]
    pending = [root_id]
    visited = {root_id}
    while pending:
        node_id = pending.pop()
        node = nodes.get(node_id)
        if node is None:
            fail(f"Cargo metadata omitted resolved dependency node {node_id}")
        for dependency in node["deps"]:
            if not any(kind.get("kind") is None for kind in dependency["dep_kinds"]):
                continue
            package_id = dependency["pkg"]
            if package_id not in visited:
                visited.add(package_id)
                pending.append(package_id)

    dependency_ids = sorted(
        visited - {root_id},
        key=lambda package_id: (
            packages[package_id]["name"],
            packages[package_id]["version"],
            packages[package_id].get("source") or "",
        ),
    )
    shutil.rmtree(output, ignore_errors=True)
    output.mkdir(parents=True)
    rows = [
        "# Surfer WASM third-party licenses",
        "",
        "| Crate | Version | License expression | Source | License files |",
        "|---|---|---|---|---|",
    ]
    for package_id in dependency_ids:
        package = packages.get(package_id)
        if package is None:
            fail(f"Cargo metadata omitted package {package_id}")
        license_expression = str(package.get("license") or "")
        license_files = crate_license_files(package)
        if not license_expression and not license_files:
            fail(
                "No license expression or license file for "
                f"{package['name']} {package['version']} ({package_id})"
            )
        package_dir = output / "dependencies" / (
            re.sub(r"[^A-Za-z0-9._+-]", "_", package["name"])
            + "-"
            + re.sub(r"[^A-Za-z0-9._+-]", "_", package["version"])
        )
        copied = []
        for license_file in license_files:
            package_dir.mkdir(parents=True, exist_ok=True)
            destination = package_dir / license_file.name
            shutil.copyfile(license_file, destination)
            copied.append(destination.relative_to(output).as_posix())
        source_value = str(package.get("source") or "local/path dependency")
        rows.append(
            "| "
            + " | ".join(
                markdown_cell(value)
                for value in (
                    package["name"],
                    package["version"],
                    license_expression or "see license files",
                    source_value,
                    ", ".join(copied) or "none",
                )
            )
            + " |"
        )
    (output / "THIRD_PARTY_NOTICES.md").write_text(
        "\n".join(rows) + "\n",
        encoding="utf-8",
    )
    print(f"Collected licenses for {len(dependency_ids)} Surfer dependency crates.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
