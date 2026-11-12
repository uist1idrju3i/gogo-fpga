#!/usr/bin/env python3
"""Create the local, hash-checked Pyodide gowin_pack asset bundle."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

from zstd_cli import require_pinned_zstd_version


ROOT = Path(sys.argv[1]).resolve()
PACKAGE_ROOT = ROOT / "node_modules/pyodide"
PACK_DIR = Path(os.environ.get("PACK_ASSET_DIR", ROOT / "build/pack")).resolve()
CACHE_DIR = Path(os.environ.get("PACK_ASSET_CACHE_DIR", ROOT / "build/cache/pack")).resolve()
CHECK_PINS = ROOT / ".github/scripts/check-pins.py"
PYODIDE_CORE_FILES = (
    "pyodide.mjs",
    "pyodide.asm.mjs",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)
PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide"
COMPRESSED_PACK_PATHS = {
    "pyodide/pyodide.asm.wasm",
    "pyodide/pyodide-lock.json",
}


def ensure_build_path(path: Path, label: str) -> None:
    build_root = (ROOT / "build").resolve()
    if path == build_root or not path.is_relative_to(build_root):
        raise RuntimeError(f"{label} must be inside {build_root}: {path}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def run_pin_command(name: str) -> list[str]:
    result = subprocess.run(
        [sys.executable, str(CHECK_PINS), name],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.rstrip("\n").split("\t")


def download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "toolchain-pack-assets/1"})
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".download")
    try:
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def verified_download(url: str, destination: Path, expected_sha256: str) -> None:
    if not destination.is_file():
        download(url, destination)
    actual = sha256(destination)
    if actual != expected_sha256:
        raise RuntimeError(
            f"SHA-256 mismatch for {destination.name}: expected {expected_sha256}, got {actual}"
        )


def copy_verified(source: Path, destination: Path, expected_sha256: str | None = None) -> None:
    if not source.is_file():
        raise RuntimeError(f"Required asset is missing: {source}")
    source_hash = sha256(source)
    if expected_sha256 is not None and source_hash != expected_sha256:
        raise RuntimeError(
            f"SHA-256 mismatch for {source.name}: expected {expected_sha256}, got {source_hash}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    if sha256(destination) != source_hash:
        raise RuntimeError(f"Copied asset failed SHA-256 verification: {destination}")


def compress_file(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as compressed:
        result = subprocess.run(
            ["zstd", "-19", "-q", "--no-progress", "-c", str(source)],
            check=False,
            stdout=compressed,
            stderr=subprocess.PIPE,
            text=True,
        )
    if result.returncode != 0:
        destination.unlink(missing_ok=True)
        detail = result.stderr.strip()
        raise RuntimeError(f"Could not compress pack asset {source}: {detail}")


def create_distribution(source: Path, requested_output: Path) -> None:
    try:
        version = require_pinned_zstd_version(ROOT)
    except RuntimeError as error:
        raise RuntimeError(str(error)) from error

    if requested_output.is_symlink():
        raise RuntimeError(f"Refusing symlink pack distribution path: {requested_output}")
    output = requested_output.absolute().resolve()
    if (
        output == Path(output.anchor)
        or output == ROOT
        or not output.is_relative_to(ROOT)
        or output == source
        or output in source.parents
        or source in output.parents
    ):
        raise RuntimeError(f"Refusing unsafe pack distribution path: {output}")

    files = sorted(
        (path for path in source.rglob("*") if path.is_file()),
        key=lambda path: path.relative_to(source).as_posix(),
    )
    if any(path.is_symlink() for path in source.rglob("*")):
        raise RuntimeError(f"Symbolic links are not supported in pack assets: {source}")
    if not files:
        raise RuntimeError(f"Pack asset directory is empty: {source}")

    if output.exists():
        if output.is_dir():
            shutil.rmtree(output)
        else:
            output.unlink()
    output.mkdir(parents=True)
    assets = []
    for path in files:
        relative_path = path.relative_to(source).as_posix()
        if relative_path == "manifest.json":
            continue
        asset = {
            "path": relative_path,
            "size": path.stat().st_size,
            "sha256": sha256(path),
        }
        if relative_path in COMPRESSED_PACK_PATHS:
            compressed_path = output / f"{relative_path}.zst"
            compress_file(path, compressed_path)
            asset.update(
                {
                    "encoding": "zstd",
                    "compressed_size": compressed_path.stat().st_size,
                    "compressed_sha256": sha256(compressed_path),
                }
            )
        else:
            copy_verified(path, output / relative_path, asset["sha256"])
        assets.append(asset)

    manifest = {"format_version": 1, "assets": assets}
    (output / "manifest.json").write_text(
        f"{json.dumps(manifest, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    total = sum(path.stat().st_size for path in output.rglob("*") if path.is_file())
    print(f"zstd: {version}; distribution: {output} ({total} bytes)")


def pyodide_version() -> str:
    root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    package_lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    installed_package = json.loads((PACKAGE_ROOT / "package.json").read_text(encoding="utf-8"))
    declared = root_package.get("devDependencies", {}).get("pyodide")
    locked = package_lock.get("packages", {}).get("node_modules/pyodide", {}).get("version")
    installed = installed_package.get("version")
    if not declared or declared != locked or locked != installed:
        raise RuntimeError(
            f"Pyodide npm pin mismatch: package.json={declared}, "
            f"package-lock.json={locked}, node_modules={installed}"
        )
    return installed


def prepare_apycula() -> Path:
    pin = run_pin_command("apycula-wheel-pins")
    if len(pin) < 2:
        raise RuntimeError("Could not read the pinned Apycula wheel hashes")
    version, *allowed_hashes = pin
    filename = f"apycula-{version}-py3-none-any.whl"
    cached = CACHE_DIR / filename
    if cached.is_file():
        actual = sha256(cached)
        if actual not in allowed_hashes or not zipfile.is_zipfile(cached):
            raise RuntimeError(
                f"Apycula wheel cache failed hash verification: {filename} ({actual})"
            )
    else:
        info = run_pin_command("apycula-wheel-info")
        if len(info) != 3 or info[0] != filename:
            raise RuntimeError("Apycula wheel metadata does not match requirements-nextpnr.txt")
        _, expected_hash, url = info
        if expected_hash not in allowed_hashes:
            raise RuntimeError("Apycula wheel hash is not in requirements-nextpnr.txt")
        verified_download(url, cached, expected_hash)
        if not zipfile.is_zipfile(cached):
            raise RuntimeError("Downloaded Apycula wheel is not a ZIP archive")
    return cached


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist-output", type=Path)
    args = parser.parse_args(sys.argv[2:])

    ensure_build_path(PACK_DIR, "PACK_ASSET_DIR")
    ensure_build_path(CACHE_DIR, "PACK_ASSET_CACHE_DIR")
    if (
        PACK_DIR == CACHE_DIR
        or PACK_DIR in CACHE_DIR.parents
        or CACHE_DIR in PACK_DIR.parents
    ):
        raise RuntimeError("PACK_ASSET_DIR and PACK_ASSET_CACHE_DIR must not overlap")
    version = pyodide_version()
    lock_source = PACKAGE_ROOT / "pyodide-lock.json"
    if not lock_source.is_file():
        raise RuntimeError(f"Pyodide lock file is missing: {lock_source}")
    lock = json.loads(lock_source.read_text(encoding="utf-8"))
    packages = lock.get("packages", {})
    if not isinstance(packages, dict):
        raise RuntimeError("Pyodide lock file has no package table")

    shutil.rmtree(PACK_DIR, ignore_errors=True)
    pyodide_dir = PACK_DIR / "pyodide"
    wheel_dir = PACK_DIR / "wheels"
    pyodide_dir.mkdir(parents=True)
    wheel_dir.mkdir(parents=True)

    for filename in PYODIDE_CORE_FILES:
        copy_verified(PACKAGE_ROOT / filename, pyodide_dir / filename)

    for name in ("micropip", "numpy", "msgspec"):
        package = packages.get(name)
        if not isinstance(package, dict):
            raise RuntimeError(f"{name} is missing from the pinned Pyodide lock file")
        filename = package.get("file_name")
        expected_hash = package.get("sha256")
        if (
            not isinstance(filename, str)
            or not filename.endswith(".whl")
            or not isinstance(expected_hash, str)
            or len(expected_hash) != 64
        ):
            raise RuntimeError(f"Invalid {name} wheel metadata in the Pyodide lock file")
        cache_path = CACHE_DIR / filename
        url = f"{PYODIDE_CDN}/v{version}/full/{filename}"
        verified_download(url, cache_path, expected_hash)
        copy_verified(cache_path, wheel_dir / filename, expected_hash)

    apycula_wheel = prepare_apycula()
    copy_verified(apycula_wheel, wheel_dir / apycula_wheel.name)
    total = sum(path.stat().st_size for path in PACK_DIR.rglob("*") if path.is_file())
    print(f"Pyodide: {version}; Python: {lock.get('info', {}).get('python', 'unknown')}")
    print(f"Assets: {PACK_DIR} ({total} bytes)")
    if args.dist_output:
        create_distribution(PACK_DIR, args.dist_output)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"build-pack-assets: {error}", file=sys.stderr)
        raise SystemExit(1) from error
