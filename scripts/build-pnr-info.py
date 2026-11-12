#!/usr/bin/env python3

import argparse
import hashlib
import importlib.util
import json
import shlex
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PIN_SCRIPT = ROOT / ".github/scripts/check-pins.py"
BUILD_SCRIPT = ROOT / "scripts/build-pnr-wasm.sh"


def load_pin_checker():
    spec = importlib.util.spec_from_file_location("check_pins", PIN_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load pin checker")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def patch_metadata(build_dir):
    return [
        translation_unit_metadata(build_dir, relative_source)
        for relative_source in ("common/place/placer_heap.cc", "himbaechel/uarch/gowin/globals.cc")
    ]


def translation_unit_metadata(build_dir, relative_source):
    source = Path(relative_source)
    metadata = json.loads((build_dir / "patched" / source.with_suffix(".json").name).read_text(encoding="utf-8"))
    patch_directory = ROOT / "patches/nextpnr"
    patch = (patch_directory / metadata["patch"]).resolve()
    if patch.parent != patch_directory.resolve():
        raise SystemExit("Invalid nextpnr patch path")
    expected = {
        "translation_unit": relative_source,
        "patch": patch.name,
        "patch_sha256": sha256_file(patch),
        "source_sha256": sha256_file(ROOT / "vendor/nextpnr" / source),
        "patched_source_sha256": sha256_file(build_dir / "patched" / source.name),
    }
    if metadata != expected:
        raise SystemExit("nextpnr patch metadata does not match the source and patch")
    return metadata


def compiler_metadata(build_dir):
    source = (build_dir / "patched/placer_heap.cc").resolve()
    if not source.is_file():
        raise SystemExit("The patched nextpnr heap placer source is missing")
    entries = json.loads((build_dir / "compile_commands.json").read_text(encoding="utf-8"))
    commands = [entry for entry in entries if (Path(entry["directory"]) / entry["file"]).resolve() == source]
    if len(commands) != 1:
        raise SystemExit("Expected exactly one nextpnr heap placer compile command")
    entry = commands[0]
    arguments = entry.get("arguments")
    if arguments is None:
        arguments = shlex.split(entry["command"])
    if not isinstance(arguments, list) or not all(isinstance(arg, str) for arg in arguments):
        raise SystemExit("Invalid nextpnr heap placer compile arguments")
    definitions = sorted(arg[2:] for arg in arguments if arg.startswith("-DEIGEN_"))
    if definitions.count("EIGEN_DONT_VECTORIZE") != 1 or any(
        arg == "-U" or arg.startswith("-UEIGEN_") for arg in arguments
    ):
        raise SystemExit("The nextpnr heap placer must disable Eigen vectorization")
    contraction = [arg for arg in arguments if arg.startswith("-ffp-contract=")]
    if contraction != ["-ffp-contract=off"] or any(
        arg in ("-Ofast", "-ffast-math", "-funsafe-math-optimizations", "-fassociative-math")
        or arg.startswith("-ffp-model=") or arg.startswith("@") for arg in arguments
    ):
        raise SystemExit("The nextpnr heap placer must disable floating-point contraction without unsafe math flags")
    return {"translation_unit": "common/place/placer_heap.cc", "eigen_definitions": definitions,
            "fp_contract": "off"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("wasi", "native"), required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--build-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    binary = args.binary.resolve()
    build_dir = args.build_dir.resolve()
    if not binary.is_file():
        raise SystemExit(f"Build artifact is missing: {binary}")

    pins = load_pin_checker()
    research = (ROOT / "RESEARCH.md").read_text(encoding="utf-8")
    nextpnr_pin = pins.parse_research_dependency(research, "nextpnr")
    archive_pins = {
        name: pins.parse_archive_pin(research, name)
        for name in ("boost", "eigen")
    }
    apycula_version, apycula_hashes = pins.parse_apycula_requirements(
        (ROOT / pins.APYCULA_REQUIREMENTS).read_text(encoding="utf-8")
    )
    chipdb = [
        {
            "path": str(path.relative_to(build_dir)),
            "size": path.stat().st_size,
            "sha256": sha256_file(path),
        }
        for path in (build_dir / "share/himbaechel/gowin").glob("chipdb-*.bin")
    ]
    chipdb.sort(key=lambda item: item["path"])
    if not chipdb:
        raise SystemExit("No generated Gowin chipdb files were found")
    metadata = {
        "format_version": 1,
        "mode": args.mode,
        "source": nextpnr_pin,
        "dependencies": {
            **{
                name: {"version": pin["version"], "sha256": pin["sha256"]}
                for name, pin in archive_pins.items()
            },
            "apycula": {"version": apycula_version, "hashes": apycula_hashes},
        },
        "build_script_sha256": sha256_file(BUILD_SCRIPT),
        "patches": patch_metadata(build_dir),
        "numerics": compiler_metadata(build_dir),
        "build_helpers": {
            name: sha256_file(ROOT / "scripts" / name)
            for name in ("nextpnr-patches.cmake", "prepare-pnr-source.py")
        },
        "artifact": {
            "path": binary.name,
            "sha256": sha256_file(binary),
            "size": binary.stat().st_size,
        },
        "chipdb": chipdb,
    }
    if args.mode == "wasi":
        metadata["wasi_sdk"] = pins.parse_wasi_sdk_pin(research)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        f"{json.dumps(metadata, indent=2, sort_keys=True)}\n",
        encoding="utf-8",
    )
    print(json.dumps(metadata, sort_keys=True))


if __name__ == "__main__":
    main()
