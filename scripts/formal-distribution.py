#!/usr/bin/env python3
"""Stage Yosys notices and audit the generated SAT assets over real local HTTP."""

import argparse
from functools import partial
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
from threading import Thread
from urllib.parse import quote
from urllib.request import urlopen

from zstd_cli import require_pinned_zstd_version


ROOT = Path(__file__).resolve().parents[1]
LIMIT = 25 * 1024 * 1024
LICENSES = {
    "yosys-COPYING": "vendor/yosys/COPYING",
    "abc-copyright.txt": "vendor/yosys/abc/copyright.txt",
    "cxxopts-LICENSE": "vendor/yosys/libs/cxxopts/LICENSE",
    "fmt-LICENSE": "vendor/yosys/libs/fmt/LICENSE",
    "tomlplusplus-LICENSE": "vendor/yosys/libs/tomlplusplus/LICENSE",
    "symfpu-LICENSE": "vendor/yosys/libs/symfpu/LICENSE",
    "symfpu-LICENSE-BSD": "vendor/yosys/libs/symfpu/LICENSE-BSD",
    "boost-LICENSE_1_0.txt": "licenses/boost-LICENSE_1_0.txt",
    "zstd-LICENSE": "vendor/zstd/LICENSE",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def stage_licenses(directory, root=ROOT):
    destination = directory / "licenses"
    destination.mkdir(parents=True, exist_ok=True)
    for name, source in LICENSES.items():
        original = root / source
        require(original.is_file() and original.stat().st_size > 0, f"Missing SAT license: {source}")
        shutil.copyfile(original, destination / name)


def get(base_url, path, limit):
    with urlopen(base_url + quote(path, safe="/"), timeout=60) as response:
        require(response.status == 200, f"HTTP failure: {path}")
        require(response.headers.get("Cross-Origin-Opener-Policy") == "same-origin", f"Missing COOP: {path}")
        require(response.headers.get("Cross-Origin-Embedder-Policy") == "require-corp", f"Missing COEP: {path}")
        data = response.read(limit + 1)
        require(len(data) <= limit, f"Oversized HTTP response: {path}")
        return data, response.headers.get_content_type()


def audit_url(base_url, root=ROOT):
    raw, mime = get(base_url, "synth/manifest.json", 256 * 1024)
    require(mime == "application/json", "SAT manifest Content-Type is not JSON")
    manifest = json.loads(raw)
    require(isinstance(manifest, dict) and type(manifest.get("format_version")) is int and
            manifest["format_version"] == 1 and
            isinstance(manifest.get("assets"), list) and 0 < len(manifest["assets"]) <= 256,
            "Invalid SAT manifest")
    entries = {}
    for entry in manifest["assets"]:
        require(isinstance(entry, dict), "Invalid SAT asset entry")
        path = entry.get("path")
        require(isinstance(path, str) and "\\" not in path and
                all(part not in ("", ".", "..") for part in path.split("/")), "Unsafe SAT asset path")
        require(path not in entries, "Duplicate SAT asset path")
        require(type(entry.get("size")) is int and 0 < entry["size"] <= 512 * 1024 * 1024 and
                re.fullmatch("[0-9a-f]{64}", str(entry.get("sha256"))), "Invalid SAT asset identity")
        require("encoding" not in entry or entry["encoding"] == "zstd", "Unsupported SAT asset encoding")
        if entry.get("encoding") == "zstd":
            require(type(entry.get("compressed_size")) is int and 0 < entry["compressed_size"] < LIMIT and
                    re.fullmatch("[0-9a-f]{64}", str(entry.get("compressed_sha256"))), "Invalid compressed SAT asset")
        entries[path] = entry
    checked = []
    for path in ("yosys.wasm", "yosys-share.tar"):
        require(path in entries, f"Missing SAT asset: {path}")
        entry = entries[path]
        compressed = entry.get("encoding") == "zstd"
        size = entry["compressed_size"] if compressed else entry["size"]
        require(size < LIMIT, f"SAT download exceeds Pages file limit: {path}")
        data, mime = get(base_url, "synth/" + path + (".zst" if compressed else ""), size)
        require(mime in ("application/wasm", "application/octet-stream", "application/zstd",
                         "application/x-zstd", "application/x-tar"), f"Unexpected SAT asset Content-Type: {path}")
        require(len(data) == size, f"SAT download size mismatch: {path}")
        require(sha256(data) == entry["compressed_sha256" if compressed else "sha256"], f"SAT download hash mismatch: {path}")
        if compressed:
            require_pinned_zstd_version(root)
            data = subprocess.run(["zstd", "-q", "-d", "-c"], input=data,
                                  capture_output=True, timeout=60, check=True).stdout
        require(len(data) == entry["size"] and sha256(data) == entry["sha256"], f"SAT decoded identity mismatch: {path}")
        if path.endswith(".wasm"):
            require(data.startswith(b"\x00asm\x01\x00\x00\x00"), "SAT executable is not WebAssembly")
        checked.append({"path": path, "size": len(data), "sha256": sha256(data), "encoding": entry.get("encoding", "raw")})
    for name, source in LICENSES.items():
        original = (root / source).read_bytes()
        served, _ = get(base_url, "licenses/" + name, LIMIT - 1)
        require(bool(original) and served == original, f"SAT license differs from source: {name}")
    return {"format_version": 1, "sat_assets": checked, "manifest_sha256": sha256(raw),
            "licenses_checked": sorted(LICENSES), "python_and_solvers": "not-audited",
            "browser_execution": "not-audited"}


def audit(directory, root=ROOT):
    spec = importlib.util.spec_from_file_location("formal_distribution_server", directory / "serve.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    handler = partial(module.WebHandler, directory=str(directory))
    with module.ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            return audit_url(f"http://127.0.0.1:{server.server_port}/", root)
        finally:
            server.shutdown()
            thread.join()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["stage-licenses", "audit"])
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    if args.action == "stage-licenses":
        stage_licenses(args.directory)
    else:
        print(json.dumps(audit(args.directory.resolve()), indent=2, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"formal-distribution: {error}", file=sys.stderr)
        raise SystemExit(1) from error
