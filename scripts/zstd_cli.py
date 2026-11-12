import re
import subprocess
from pathlib import Path


VERSION_PATTERN = re.compile(r"\bv(\d+\.\d+\.\d+)\b")
HEADER_VERSION_PATTERN = re.compile(
    r"^\s*#\s*define\s+ZSTD_VERSION_(MAJOR|MINOR|RELEASE)\s+(\d+)\b",
    re.MULTILINE,
)


def zstd_version():
    try:
        result = subprocess.run(
            ["zstd", "--version"],
            check=False,
            capture_output=True,
            text=True,
        )
    except OSError as error:
        raise RuntimeError(f"Could not run zstd: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(f"Could not query zstd version: {detail}")
    match = VERSION_PATTERN.search(result.stdout)
    if not match:
        raise RuntimeError("Could not determine zstd version")
    return match.group(1)


def require_pinned_zstd_version(root):
    header = Path(root) / "vendor/zstd/lib/zstd.h"
    try:
        contents = header.read_text(encoding="utf-8")
    except OSError as error:
        raise RuntimeError(f"Could not read pinned zstd version from {header}: {error}") from error
    versions = dict(HEADER_VERSION_PATTERN.findall(contents))
    if set(versions) != {"MAJOR", "MINOR", "RELEASE"}:
        raise RuntimeError(f"Could not parse pinned zstd version from {header}")
    pinned = ".".join(versions[name] for name in ("MAJOR", "MINOR", "RELEASE"))
    actual = zstd_version()
    if actual != pinned:
        raise RuntimeError(
            f"zstd CLI version {actual} does not match vendor/zstd version {pinned}"
        )
    return actual
