#!/usr/bin/env python3

import argparse
from datetime import datetime, timezone
from pathlib import Path
import re
import subprocess
import sys


def source_metadata(source, commit):
    if (source / ".git").exists():
        def git(*args):
            return subprocess.check_output(
                ["git", "-C", str(source), *args], text=True,
            ).strip()

        revision = git("rev-parse", "HEAD")
        timestamp = git("show", "-s", "--format=%ct", "HEAD")
    else:
        revision = (source / ".gitcommit").read_text().strip()
        timestamp = (source / ".gitcommit-timestamp").read_text().strip()
    if revision != commit:
        raise ValueError("Surfer metadata revision does not match its pin")
    if not re.fullmatch(r"[0-9]+", timestamp):
        raise ValueError("Surfer commit timestamp must be a non-negative integer")
    date = datetime.fromtimestamp(int(timestamp), timezone.utc).date().isoformat()
    return f"{timestamp}\t{date}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        print(source_metadata(args.source, args.commit))
    except (OSError, ValueError, OverflowError, subprocess.CalledProcessError) as error:
        print(f"Surfer source metadata: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
