#!/usr/bin/env python3
"""Write deterministic metadata for an Icarus Verilog build."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("wasi", "native"), required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--build-info", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--wasi-sdk-version")
    parser.add_argument("--compiler-version", required=True)
    parser.add_argument("--flags", required=True)
    parser.add_argument("--patch-sha256", required=True)
    args = parser.parse_args()

    artifacts = {}
    for name in ("ivlpp", "ivl", "vvp"):
        suffix = ".wasm" if args.mode == "wasi" else ""
        path = args.output_dir / f"{name}{suffix}"
        if not path.is_file():
            parser.error(f"required build artifact is missing: {path}")
        artifacts[path.name] = {
            "bytes": path.stat().st_size,
            "sha256": sha256(path),
        }

    info = {
        "format": 1,
        "mode": args.mode,
        "iverilog": {"version": args.version, "commit": args.commit},
        "compiler": args.compiler_version,
        "flags": args.flags,
        "patches": [{"path": "patches/iverilog/static-wasi.patch", "sha256": args.patch_sha256}],
        "artifacts": artifacts,
    }
    if args.mode == "wasi":
        info["wasi_sdk"] = args.wasi_sdk_version
    args.build_info.parent.mkdir(parents=True, exist_ok=True)
    args.build_info.write_text(json.dumps(info, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
