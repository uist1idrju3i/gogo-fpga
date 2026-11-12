#!/usr/bin/env python3
"""Check that simulator TAP reports cover the shard table exactly once."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


RESULT_LINE = re.compile(r"^(not )?ok \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)(?:\s+.*)?)?$")


def parse_tap(text: str) -> tuple[set[str], set[str], int | None, bool]:
    passed: set[str] = set()
    failed: set[str] = set()
    failure_count = None
    has_plan = False
    for line in text.splitlines():
        if re.fullmatch(r"1\.\.\d+", line):
            has_plan = True
        count = re.fullmatch(r"# fail (\d+)", line)
        if count:
            failure_count = int(count.group(1))
        result = RESULT_LINE.fullmatch(line)
        if not result:
            continue
        is_failure, name, directive = result.groups()
        if directive is not None:
            continue
        (failed if is_failure else passed).add(name)
    return passed, failed, failure_count, has_plan


def check_reports(table: dict[str, int], reports_dir: Path) -> list[str]:
    errors: list[str] = []
    if not table or any(not isinstance(name, str) or not name for name in table):
        return ["shards.json must map non-empty test names to shard numbers"]
    if any(type(shard) is not int or shard not in (1, 2, 3) for shard in table.values()):
        return ["shards.json values must be shard numbers 1, 2, or 3"]

    passed_all: set[str] = set()
    for shard in range(1, 4):
        path = reports_dir / f"sim-shard-{shard}" / "sim-shard.tap"
        if not path.is_file():
            errors.append(f"missing shard {shard} TAP report: {path}")
            continue
        passed, failed, failure_count, has_plan = parse_tap(path.read_text(encoding="utf-8"))
        if not has_plan or failure_count is None:
            errors.append(f"shard {shard} TAP report has no complete summary")
        if failed or failure_count:
            errors.append(f"shard {shard} has failures: {', '.join(sorted(failed)) or failure_count}")
        duplicates = passed_all & passed
        if duplicates:
            errors.append(f"tests passed in multiple shards: {', '.join(sorted(duplicates))}")
        passed_all.update(passed)
        expected = {name for name, assigned in table.items() if assigned == shard}
        if passed != expected:
            errors.append(
                f"shard {shard} passed names differ from its assignment "
                f"(missing: {sorted(expected - passed)}; unexpected: {sorted(passed - expected)})"
            )

    unused = set(table) - passed_all
    unexpected = passed_all - set(table)
    if unused:
        errors.append(f"unused shard table entries: {', '.join(sorted(unused))}")
    if unexpected:
        errors.append(f"passed tests missing from shards.json: {', '.join(sorted(unexpected))}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shards", type=Path, default=Path("tests/sim/shards.json"))
    parser.add_argument("--reports-dir", type=Path, default=Path("sim-results"))
    args = parser.parse_args()
    try:
        table = json.loads(args.shards.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"cannot read shard table: {error}", file=sys.stderr)
        return 2
    if not isinstance(table, dict):
        print("shards.json must be a JSON object", file=sys.stderr)
        return 2
    errors = check_reports(table, args.reports_dir)
    if errors:
        for error in errors:
            print(error, file=sys.stderr)
        return 1
    print(f"All {len(table)} simulator tests passed exactly once across 3 shards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
