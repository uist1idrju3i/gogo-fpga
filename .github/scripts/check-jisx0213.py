#!/usr/bin/env python3
"""Check tracked text against the JIS X 0213:2004 mapping table."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import os
import re
import stat
import subprocess
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path


TABLE_SHA256 = "388ae7822cbf0aecff09b8466dd630ea343673d01a3c7df9d61947ad1ad5b2dd"
TABLE_PATH = Path(__file__).parent / "data" / "jisx0213-2004-std.txt"
TABLE_REPO_PATH = ".github/scripts/data/jisx0213-2004-std.txt"
ALLOWLIST_PATH = Path(__file__).parents[1] / "jisx0213-allowlist.tsv"
CODEPOINT_RE = re.compile(r"U\+([0-9A-Fa-f]{4,6})(?:\+([0-9A-Fa-f]{4,6}))?")
ALTERNATE_RE = re.compile(r"(?:Fullwidth|Windows): U\+([0-9A-Fa-f]{4,6})")
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
BLOCKQUOTE_RE = re.compile(r"^ {0,3}>")


@dataclass(frozen=True)
class MappingTable:
    singles: frozenset[int]
    sequences: frozenset[tuple[int, int]]
    alternates: frozenset[int]
    added: frozenset[int]

    @property
    def characters(self) -> frozenset[int]:
        return self.singles | self.alternates


@dataclass(frozen=True)
class AllowEntry:
    kind: str
    path: str
    chars: frozenset[str]
    reason: str
    line: int


class Reporter:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.files = 0

    def issue(self, level: str, path: str, line: int, col: int, message: str) -> None:
        print(f"{path}:{line}:{col}: {level}: {message}")
        if os.environ.get("GITHUB_ACTIONS") == "true":
            safe_path = path.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A").replace(",", "%2C")
            safe_message = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(
                f"::{level} file={safe_path},line={line},col={col}::{safe_message}"
            )
        if level == "error":
            self.errors += 1
        else:
            self.warnings += 1

    def summary(self) -> None:
        print(f"Summary: errors={self.errors} warnings={self.warnings} files={self.files}")


def load_table(path: Path = TABLE_PATH) -> MappingTable:
    raw = path.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != TABLE_SHA256:
        raise ValueError(
            f"JIS X 0213 mapping table SHA-256 mismatch: expected {TABLE_SHA256}, got {digest}"
        )

    singles: set[int] = set()
    sequences: set[tuple[int, int]] = set()
    alternates: set[int] = set()
    added: set[int] = set()
    for number, line in enumerate(raw.decode("utf-8").splitlines(), 1):
        if not line or line.startswith("##"):
            continue
        columns = line.split("\t")
        if len(columns) < 2:
            raise ValueError(f"malformed mapping table line {number}")
        value = columns[1]
        if not value:
            continue
        match = CODEPOINT_RE.fullmatch(value)
        if match is None:
            raise ValueError(f"malformed code point on mapping table line {number}: {value}")
        first = int(match.group(1), 16)
        second = match.group(2)
        notes = "\t".join(columns[2:])
        if second is None:
            singles.add(first)
        else:
            sequences.add((first, int(second, 16)))
        if "[2000]" in notes or "[2004]" in notes:
            added.add(first)
        alternates.update(int(codepoint, 16) for codepoint in ALTERNATE_RE.findall(notes))
    alternates.difference_update(singles)
    return MappingTable(
        frozenset(singles),
        frozenset(sequences),
        frozenset(alternates),
        frozenset(added),
    )


def load_allowlist(path: Path) -> tuple[list[AllowEntry], list[tuple[int, str]]]:
    entries: list[AllowEntry] = []
    errors: list[tuple[int, str]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as exc:
        return [], [(1, f"cannot read allowlist: {exc}")]

    for number, line in enumerate(lines, 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            errors.append((number, "malformed allowlist line: expected four TSV columns"))
            continue
        kind, pattern, chars, reason = fields
        if not reason.strip():
            errors.append((number, "allowlist reason must not be empty"))
            continue
        if kind not in {"file", "quote"}:
            errors.append((number, f"unknown allowlist kind: {kind}"))
            continue
        if not pattern or not chars:
            errors.append((number, "allowlist path and chars must not be empty"))
            continue
        if kind == "file" and chars != "*":
            errors.append((number, "file allowlist chars must be *"))
            continue
        if kind == "quote" and any(char in pattern for char in "*?["):
            errors.append((number, "quote allowlist path must be exact"))
            continue
        entries.append(
            AllowEntry(
                kind,
                pattern.replace(os.sep, "/"),
                frozenset(chars) if chars != "*" else frozenset(),
                reason,
                number,
            )
        )
    return entries, errors


def quote_mask(line: str, in_fence: tuple[str, int] | None) -> tuple[list[bool], tuple[str, int] | None]:
    mask = [False] * len(line)
    fence_match = FENCE_RE.match(line)
    if in_fence is not None:
        mask[:] = [True] * len(line)
        if fence_match and fence_match.group(1)[0] == in_fence[0] and len(fence_match.group(1)) >= in_fence[1]:
            return mask, None
        return mask, in_fence
    if fence_match:
        mask[:] = [True] * len(line)
        run = fence_match.group(1)
        return mask, (run[0], len(run))
    if BLOCKQUOTE_RE.match(line):
        return [True] * len(line), None

    runs = list(re.finditer(r"`+", line))
    index = 0
    while index < len(runs):
        opener = runs[index]
        length = len(opener.group())
        closer_index = next(
            (candidate for candidate in range(index + 1, len(runs)) if len(runs[candidate].group()) == length),
            None,
        )
        if closer_index is None:
            index += 1
            continue
        closer = runs[closer_index]
        mask[opener.start() : closer.end()] = [True] * (closer.end() - opener.start())
        index = closer_index + 1
    return mask, None


def tracked_paths() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf-8", errors="replace").strip() or "git ls-files failed")
    paths = [os.fsdecode(path) for path in result.stdout.split(b"\0") if path]
    return [
        path
        for path in paths
        if path.replace(os.sep, "/") != TABLE_REPO_PATH
        and not path.replace(os.sep, "/").startswith("vendor/")
    ]


def location_for_byte(raw: bytes, offset: int) -> tuple[int, int]:
    prefix = raw[:offset].decode("utf-8", errors="replace")
    lines = re.split(r"\r\n|\n|\r", prefix)
    return len(lines), len(lines[-1]) + 1


def github_ideograph(codepoint: int) -> bool:
    return unicodedata.name(chr(codepoint), "").startswith("CJK UNIFIED IDEOGRAPH-")


def scan_file(
    raw_path: str,
    mappings: MappingTable,
    entries: list[AllowEntry],
    reporter: Reporter,
    file_used: set[int],
    quote_used: dict[int, set[str]],
) -> None:
    path = Path(raw_path)
    try:
        mode = path.lstat().st_mode
    except OSError as exc:
        reporter.issue("error", raw_path, 1, 1, f"ファイルを確認できません: {exc}")
        return
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        return
    try:
        raw = path.read_bytes()
    except OSError as exc:
        reporter.issue("error", raw_path, 1, 1, f"ファイルを読み込めません: {exc}")
        return
    if b"\0" in raw[:8192]:
        return
    reporter.files += 1
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        line, col = location_for_byte(raw, exc.start)
        reporter.issue("error", raw_path, line, col, "無効な UTF-8 です")
        return

    display_path = raw_path.replace(os.sep, "/")
    file_entries = [
        (index, entry)
        for index, entry in enumerate(entries)
        if entry.kind == "file" and fnmatch.fnmatchcase(display_path, entry.path)
    ]
    quote_entries = []
    if display_path.endswith(".md"):
        quote_entries = [
            (index, entry)
            for index, entry in enumerate(entries)
            if entry.kind == "quote" and display_path == entry.path
        ]
    lines = re.split(r"\r\n|\n|\r", text)
    in_fence: tuple[str, int] | None = None
    for line_number, line in enumerate(lines, 1):
        mask, in_fence = quote_mask(line, in_fence)
        for entry_index, entry in quote_entries:
            for char in entry.chars:
                if any(line[index] == char and mask[index] for index in range(len(line))):
                    quote_used.setdefault(entry_index, set()).add(char)

        index = 0
        while index < len(line):
            codepoint = ord(line[index])
            if index + 1 < len(line):
                pair = (codepoint, ord(line[index + 1]))
                if pair in mappings.sequences:
                    index += 2
                    continue
            if (
                0x20 <= codepoint <= 0x7E
                or codepoint in (0x09, 0x0A, 0x0D)
                or codepoint in mappings.characters
            ):
                if codepoint in mappings.added and github_ideograph(codepoint):
                    reporter.issue(
                        "warning",
                        raw_path,
                        line_number,
                        index + 1,
                        f"U+{codepoint:04X} {line[index]!r} ({unicodedata.name(line[index], '?')}) は第3・第4水準漢字です。簡体字の混入がないか確認してください",
                    )
                index += 1
                continue

            if mask[index] and any(line[index] in entry.chars for _, entry in quote_entries):
                index += 1
                continue
            if file_entries:
                file_used.update(entry_index for entry_index, _ in file_entries)
                index += 1
                continue
            char = line[index]
            reporter.issue(
                "error",
                raw_path,
                line_number,
                index + 1,
                f"U+{codepoint:04X} {char!r} ({unicodedata.name(char, '?')}) は JIS X 0213:2004 の範囲外です",
            )
            index += 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allowlist", type=Path, default=ALLOWLIST_PATH)
    parser.add_argument("paths", nargs="*", help="text files to scan; defaults to all tracked files")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    args = parser.parse_args()
    reporter = Reporter()

    table_path = Path(os.environ.get("MSD_JISX0213_TABLE", TABLE_PATH))
    try:
        mappings = load_table(table_path)
    except (OSError, UnicodeError, ValueError) as exc:
        reporter.issue("error", str(table_path), 1, 1, str(exc))
        reporter.summary()
        return 2

    entries, allowlist_errors = load_allowlist(args.allowlist)
    for line, message in allowlist_errors:
        reporter.issue("error", str(args.allowlist), line, 1, message)
    default_set = not args.paths
    try:
        paths = tracked_paths() if default_set else args.paths
    except RuntimeError as exc:
        reporter.issue("error", "git", 1, 1, str(exc))
        reporter.summary()
        return 2

    file_used: set[int] = set()
    quote_used: dict[int, set[str]] = {}
    for path in paths:
        scan_file(path, mappings, entries, reporter, file_used, quote_used)

    if default_set:
        for index, entry in enumerate(entries):
            if entry.kind == "file" and index not in file_used:
                reporter.issue(
                    "error",
                    str(args.allowlist),
                    entry.line,
                    1,
                    f"stale file allowlist entry: {entry.path} has no scanned out-of-range characters",
                )
            if entry.kind == "quote":
                unused = entry.chars - quote_used.get(index, set())
                for char in sorted(unused, key=ord):
                    reporter.issue(
                        "error",
                        str(args.allowlist),
                        entry.line,
                        1,
                        f"stale quote allowlist entry: U+{ord(char):04X} is unused in a quote context of {entry.path}",
                    )

    reporter.summary()
    return 1 if reporter.errors or (args.strict and reporter.warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
