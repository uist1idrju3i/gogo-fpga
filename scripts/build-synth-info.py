#!/usr/bin/env python3

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PIN_SCRIPT = ROOT / ".github/scripts/check-pins.py"
BUILD_SCRIPT = ROOT / "scripts/build-synth-wasm.sh"


def load_pin_checker():
    spec = importlib.util.spec_from_file_location("check_pins", PIN_SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("Could not load pin checker")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_artifact(mode, binary, output):
    try:
        metadata = json.loads(output.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"Could not read build info: {output}: {error}") from error
    if not isinstance(metadata, dict):
        raise SystemExit(f"Build info is not a JSON object: {output}")
    artifact = metadata.get("artifact")
    if metadata.get("mode") != mode or not isinstance(artifact, dict):
        raise SystemExit(f"Build info does not describe a {mode} artifact: {output}")
    actual_sha256 = sha256_file(binary)
    actual_size = binary.stat().st_size
    if (
        artifact.get("path") != binary.name
        or artifact.get("sha256") != actual_sha256
        or artifact.get("size") != actual_size
    ):
        raise SystemExit(f"Build artifact integrity check failed: {binary}")
    if mode == "native":
        abc_binary = binary.with_name("yosys-abc")
        if not abc_binary.is_file():
            raise SystemExit(f"Native ABC helper is missing: {abc_binary}")
    print(f"Build artifact integrity verified: {binary}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("wasi", "native"), required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        raise SystemExit(f"Build artifact is missing: {binary}")
    if args.check:
        check_artifact(args.mode, binary, args.output)
        return

    pins = load_pin_checker()
    research = (ROOT / "RESEARCH.md").read_text(encoding="utf-8")
    yosys_pin = pins.parse_research_dependency(research, "yosys")
    artifact = {
        "path": binary.name,
        "sha256": sha256_file(binary),
        "size": binary.stat().st_size,
    }
    metadata = {
        "format_version": 1,
        "mode": args.mode,
        "source": {
            "name": "Yosys",
            "version": yosys_pin["version"],
            "commit": yosys_pin["commit"],
            "url": yosys_pin["url"],
        },
        "build_script_sha256": sha256_file(BUILD_SCRIPT),
        "artifact": artifact,
    }
    if args.mode == "wasi":
        metadata["wasi_sdk"] = pins.parse_wasi_sdk_pin(research)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(f"{json.dumps(metadata, indent=2, sort_keys=True)}\n", encoding="utf-8")
    print(json.dumps(metadata, sort_keys=True))


if __name__ == "__main__":
    main()
