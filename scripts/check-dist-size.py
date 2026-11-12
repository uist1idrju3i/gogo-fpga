#!/usr/bin/env python3

import argparse
import sys
from pathlib import Path


MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_FILES = 20_000


def check_dist(directory: Path) -> None:
    if directory.is_symlink() or not directory.is_dir():
        raise RuntimeError(f"Distribution directory is missing: {directory}")
    files = 0
    for path in sorted(directory.rglob("*")):
        if path.is_symlink() or not (path.is_dir() or path.is_file()):
            raise RuntimeError(f"Distribution contains a non-regular entry: {path}")
        if path.is_file():
            files += 1
            if files >= MAX_FILES:
                raise RuntimeError(f"Distribution must contain fewer than {MAX_FILES} files")
        if path.is_file() and path.stat().st_size >= MAX_FILE_BYTES:
            relative = path.relative_to(directory).as_posix()
            raise RuntimeError(
                f"Distribution file is at least 25 MiB: {relative} "
                f"({path.stat().st_size} bytes; limit {MAX_FILE_BYTES})"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    check_dist(args.directory)


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError) as error:
        print(f"check-dist-size: {error}", file=sys.stderr)
        raise SystemExit(1) from error
