#!/usr/bin/env python3
"""Rebuild the tracked S15 boundary CSVs from independently audited raw runs."""

import argparse
import csv
import io
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def make_csv(source, labels):
    buffer = io.StringIO(newline="")
    writer = None
    for label in labels:
        for kind in ("patched", "unpatched"):
            directory = source / f"boundary-{kind}-{label}"
            subprocess.run(
                ["python3", str(ROOT / "scripts/audit-extra-solver-boundaries.py"),
                 "--input", str(directory)], check=True, capture_output=True,
            )
            with (directory / "results.csv").open(newline="") as stream:
                reader = csv.DictReader(stream)
                if writer is None:
                    writer = csv.DictWriter(buffer, fieldnames=["run", *reader.fieldnames], lineterminator="\n")
                    writer.writeheader()
                elif writer.fieldnames != ["run", *reader.fieldnames]:
                    raise ValueError("The raw CSV schemas differ")
                for row in reader:
                    writer.writerow({"run": label, **row})
    return buffer.getvalue().encode("utf-8")


def main(args):
    for name, labels in (
        ("formal", [f"formal-{i:02}" for i in range(1, 6)]),
        ("aa", ["AA-01", "AA-02"]),
    ):
        path = ROOT / "docs/experiments" / f"S15-solver-boundaries-{name}.csv"
        data = make_csv(args.source, labels)
        if args.check:
            if path.read_bytes() != data:
                raise ValueError(f"The tracked CSV differs from raw runs: {path}")
        else:
            with path.open("xb") as stream:
                stream.write(data)
        print(f"{path.name}: {len(data.splitlines()) - 1} rows")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "build/S15")
    parser.add_argument("--check", action="store_true")
    main(parser.parse_args())
