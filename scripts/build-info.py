#!/usr/bin/env python3

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from zstd_cli import zstd_version


SUBMODULES = (
    "vendor/emsdk",
    "vendor/libftdi",
    "vendor/libusb",
    "vendor/openFPGALoader",
    "vendor/yomiyasu",
    "vendor/zlib",
    "vendor/yosys",
    "vendor/iverilog",
    "vendor/surfer",
)
RELEASE_SOURCE_KEYS = {"version", "commit", "submodule_shas", "emsdk_version"}


def run_git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.rstrip("\n")


def release_source_data(root):
    if (root / ".git").exists():
        return None
    manifest = root / "RELEASE-SOURCE.json"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read release-source metadata {manifest}: {error}") from error
    if not isinstance(data, dict):
        raise RuntimeError(f"Release-source metadata must be a JSON object: {manifest}")
    missing = sorted(RELEASE_SOURCE_KEYS - set(data))
    if missing:
        raise RuntimeError(
            f"Release-source metadata is missing required keys: {', '.join(missing)}"
        )
    if not isinstance(data["version"], str) or not data["version"].strip():
        raise RuntimeError("Release-source metadata version must be a non-empty string")
    if not isinstance(data["commit"], str) or len(data["commit"]) != 40:
        raise RuntimeError("Release-source metadata commit must be a 40-character SHA")
    if not isinstance(data["emsdk_version"], str) or not data["emsdk_version"].strip():
        raise RuntimeError("Release-source metadata emsdk_version must be a non-empty string")
    versions = data["submodule_shas"]
    if not isinstance(versions, dict) or set(versions) != set(SUBMODULES):
        raise RuntimeError(
            "Release-source metadata submodule_shas paths do not match required submodules"
        )
    if any(
        not isinstance(sha, str)
        or len(sha) != 40
        or any(char not in "0123456789abcdef" for char in sha)
        for sha in versions.values()
    ):
        raise RuntimeError("Release-source metadata contains an invalid submodule SHA")
    return data


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as contents:
        for chunk in iter(lambda: contents.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def submodule_shas(root):
    release_source = release_source_data(root)
    if release_source is not None:
        return release_source["submodule_shas"]
    output = run_git(root, "submodule", "status", "--", *SUBMODULES)
    versions = {}
    for line in output.splitlines():
        if not line:
            continue
        status = line[0]
        fields = line[1:].split()
        if len(fields) < 2:
            raise RuntimeError(f"Could not parse submodule status line: {line}")
        sha, path = fields[:2]
        if status != " ":
            raise RuntimeError(
                f"Submodule {path} has status {status!r}, not a clean checkout: {line}"
            )
        if path not in SUBMODULES:
            raise RuntimeError(f"Unexpected vendor submodule in status: {path}")
        versions[path] = sha
    if set(versions) != set(SUBMODULES):
        missing = sorted(set(SUBMODULES) - set(versions))
        raise RuntimeError(f"Missing vendor submodule revisions: {', '.join(missing)}")
    return versions


def emsdk_version(root):
    release_source = release_source_data(root)
    if release_source is not None:
        return release_source["emsdk_version"]
    return run_git(
        root / "vendor/emsdk",
        "describe",
        "--tags",
        "--exact-match",
    )


def emcc_version(root):
    version = emsdk_version(root)
    sdk_root = root / "build" / f"emsdk-{version}"
    env_script = sdk_root / "emsdk_env.sh"
    if not env_script.is_file():
        raise RuntimeError(f"Emscripten environment is missing: {env_script}")

    result = subprocess.run(
        [
            "bash",
            "-c",
            'source "$1/emsdk_env.sh" >/dev/null 2>&1 && emcc --version',
            "build-info",
            str(sdk_root),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip()
        raise RuntimeError(f"Could not query emcc version: {detail}")
    first_line = next((line.strip() for line in result.stdout.splitlines() if line.strip()), "")
    if not first_line:
        raise RuntimeError("emcc --version returned no version information")
    return first_line


def collect_build_info(root, artifacts, variant, async_mode):
    return {
        "variant": variant,
        "async_mode": async_mode,
        "build_script_sha256": sha256_file(root / "scripts/build-wasm.sh"),
        "submodule_shas": submodule_shas(root),
        "emcc_version": emcc_version(root),
        "zstd_version": zstd_version(),
        "artifacts": {
            name: sha256_file(artifacts / name)
            for name in ("openFPGALoader.mjs", "openFPGALoader.wasm")
        },
    }


def write_build_info(root, artifacts, variant, async_mode):
    info = collect_build_info(root, artifacts, variant, async_mode)
    info_path = artifacts / "build-info.json"
    info_path.write_text(f"{json.dumps(info, indent=2, sort_keys=True)}\n")
    print(f"Wrote build metadata to {info_path}")


def check_build_info(root, artifacts):
    info_path = artifacts / "build-info.json"
    if not info_path.is_file():
        raise RuntimeError(f"Required build metadata is missing: {info_path}")
    try:
        actual = json.loads(info_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read build metadata {info_path}: {error}") from error
    if not isinstance(actual, dict):
        raise RuntimeError(f"Build metadata must be a JSON object: {info_path}")
    if actual.get("variant") != "C":
        raise RuntimeError(
            f"Build metadata variant must be C, got {actual.get('variant')!r}"
        )
    if actual.get("async_mode") != "jspi":
        raise RuntimeError(
            f"Build metadata async_mode must be jspi, got {actual.get('async_mode')!r}"
        )

    expected = collect_build_info(root, artifacts, "C", "jspi")
    for field, value in expected.items():
        if field in ("variant", "async_mode"):
            continue
        if actual.get(field) != value:
            raise RuntimeError(f"Build metadata field {field!r} does not match current inputs")
    if set(actual) != set(expected):
        unexpected = sorted(set(actual) - set(expected))
        raise RuntimeError(f"Build metadata has unexpected fields: {', '.join(unexpected)}")
    print(f"Verified C JSPI build metadata in {info_path}")


def submodule_gitlinks(root):
    release_source = release_source_data(root)
    if release_source is not None:
        return release_source["submodule_shas"]
    output = run_git(root, "ls-tree", "HEAD", "--", *SUBMODULES)
    versions = {}
    for line in output.splitlines():
        metadata, path = line.split("\t", 1)
        mode, object_type, sha = metadata.split()
        if mode != "160000" or object_type != "commit":
            raise RuntimeError(f"Expected a gitlink for submodule {path}")
        versions[path] = sha
    if set(versions) != set(SUBMODULES):
        missing = sorted(set(SUBMODULES) - set(versions))
        extra = sorted(set(versions) - set(SUBMODULES))
        raise RuntimeError(
            f"Build metadata gitlink paths do not match: missing={missing}, extra={extra}"
        )
    return versions


def check_artifacts(root, artifacts):
    info_path = artifacts / "build-info.json"
    if not info_path.is_file():
        raise RuntimeError(f"Required build metadata is missing: {info_path}")
    try:
        actual = json.loads(info_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Could not read build metadata {info_path}: {error}") from error
    if not isinstance(actual, dict):
        raise RuntimeError(f"Build metadata must be a JSON object: {info_path}")

    expected_keys = {
        "variant",
        "async_mode",
        "build_script_sha256",
        "submodule_shas",
        "emcc_version",
        "zstd_version",
        "artifacts",
    }
    if set(actual) != expected_keys:
        raise RuntimeError(
            f"Build metadata keys do not match: missing={sorted(expected_keys - set(actual))}, "
            f"extra={sorted(set(actual) - expected_keys)}"
        )
    if actual["variant"] != "C":
        raise RuntimeError(f"Build metadata variant must be C, got {actual['variant']!r}")
    if actual["async_mode"] != "jspi":
        raise RuntimeError(
            f"Build metadata async_mode must be jspi, got {actual['async_mode']!r}"
        )
    if actual["build_script_sha256"] != sha256_file(root / "scripts/build-wasm.sh"):
        raise RuntimeError("Build metadata build_script_sha256 does not match current build script")
    if actual["submodule_shas"] != submodule_gitlinks(root):
        raise RuntimeError("Build metadata submodule_shas does not match superproject gitlinks")
    if not isinstance(actual["emcc_version"], str) or not actual["emcc_version"].strip():
        raise RuntimeError("Build metadata emcc_version must be a non-empty string")
    if actual["zstd_version"] != zstd_version():
        raise RuntimeError("Build metadata zstd_version does not match the current CLI")
    expected_artifacts = {
        name: sha256_file(artifacts / name)
        for name in ("openFPGALoader.mjs", "openFPGALoader.wasm")
    }
    if actual["artifacts"] != expected_artifacts:
        raise RuntimeError("Build metadata artifacts do not match downloaded files")
    # The build job's full check validated emcc_version in the same run.
    print(f"Verified artifact metadata in {info_path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("write", "check", "check-artifacts"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--artifacts", type=Path, required=True)
    parser.add_argument("--variant")
    parser.add_argument("--async-mode", choices=("jspi", "asyncify"))
    args = parser.parse_args()
    root = args.root.resolve()
    artifacts = args.artifacts.resolve()
    try:
        if release_source_data(root) is not None:
            print("Release-source mode is on.")
        if args.action == "write":
            if args.variant is None or args.async_mode is None:
                parser.error("write requires --variant and --async-mode")
            write_build_info(root, artifacts, args.variant, args.async_mode)
        elif args.action == "check":
            check_build_info(root, artifacts)
        else:
            check_artifacts(root, artifacts)
    except (OSError, subprocess.CalledProcessError, RuntimeError) as error:
        print(f"build-info: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
