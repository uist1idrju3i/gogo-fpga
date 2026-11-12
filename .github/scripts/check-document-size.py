#!/usr/bin/env python3
"""Check tracked Markdown sizes and narrowly scoped, reason-carrying exceptions."""

from __future__ import annotations

import argparse
import os
import re
import stat
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath


REVIEW_BYTES = 20_000
LIMIT_BYTES = 40_000
ALLOWLIST = ".github/document-size-allowlist.tsv"
KINDS = frozenset({"upstream", "license", "generated-evidence", "indivisible-record"})


class Reporter:
    def __init__(self) -> None:
        self.errors = 0
        self.warnings = 0
        self.files = 0

    def issue(self, level: str, path: str, message: str) -> None:
        print(f"{path}:1: {level}: {message}")
        if os.environ.get("GITHUB_ACTIONS") == "true":
            def escape(value: str) -> str:
                return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            print(f"::{level} file={escape(path).replace(',', '%2C')},line=1::{escape(message)}")
        if level == "error":
            self.errors += 1
        else:
            self.warnings += 1


@dataclass(frozen=True)
class ExceptionEntry:
    kind: str
    maximum: int
    reason: str


def tracked_modes(root: Path) -> dict[str, str]:
    result = subprocess.run(["git", "-C", str(root), "ls-files", "--stage", "-z"],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise ValueError(result.stderr.decode("utf-8", errors="replace").strip() or "git ls-files failed")
    modes: dict[str, str] = {}
    for record in result.stdout.split(b"\0"):
        if not record:
            continue
        metadata, name = record.split(b"\t", 1)
        mode, _, stage = metadata.decode("ascii").split()
        path = os.fsdecode(name)
        if stage != "0" or path in modes:
            raise ValueError(f"Unmerged or duplicate index entry: {path}")
        modes[path] = mode
    return modes


def read_regular(root: Path, path: str) -> bytes:
    current = root
    parts = PurePosixPath(path).parts
    for index, part in enumerate(parts):
        current = current / part
        mode = current.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise ValueError(f"シンボリックリンクを経由しています: {path}")
        if index < len(parts) - 1 and not stat.S_ISDIR(mode):
            raise ValueError(f"親がディレクトリーではありません: {path}")
    if not stat.S_ISREG(mode):
        raise ValueError(f"通常のファイルではありません: {path}")
    return current.read_bytes()


def load_exceptions(root: Path, modes: dict[str, str]) -> dict[str, ExceptionEntry]:
    if modes.get(ALLOWLIST) not in {"100644", "100755"}:
        raise ValueError("例外リストが追跡した通常のファイルではありません")
    entries: dict[str, ExceptionEntry] = {}
    for number, line in enumerate(read_regular(root, ALLOWLIST).decode("utf-8").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 4:
            raise ValueError(f"例外の列数が不正です: {number}")
        path, kind, maximum, reason = fields
        parts = PurePosixPath(path).parts
        if (not parts or path != "/".join(parts) or PurePosixPath(path).is_absolute()
                or ".." in parts or any(char in path for char in "*?[]\\")
                or not path.lower().endswith((".md", ".markdown"))):
            raise ValueError(f"例外は正確な相対 Markdown パスにしてください: {number}")
        if path in entries:
            raise ValueError(f"例外が重複しています: {path}")
        if modes.get(path) not in {"100644", "100755"}:
            raise ValueError(f"例外の対象が追跡した通常のファイルではありません: {path}")
        if kind not in KINDS or not reason.strip():
            raise ValueError(f"例外の種別または理由が不正です: {number}")
        if not re.fullmatch(r"[0-9]+", maximum) or int(maximum) <= LIMIT_BYTES:
            raise ValueError(f"例外の上限は {LIMIT_BYTES} より大きいバイト数にしてください: {number}")
        entries[path] = ExceptionEntry(kind, int(maximum), reason)
    return entries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    args = parser.parse_args()
    root = args.root.resolve()
    reporter = Reporter()
    try:
        modes = tracked_modes(root)
        exceptions = load_exceptions(root, modes)
    except (OSError, ValueError) as exc:
        reporter.issue("error", ALLOWLIST, str(exc))
        return 1
    for path, mode in sorted(modes.items()):
        if mode in {"120000", "160000"} or not path.lower().endswith((".md", ".markdown")):
            continue
        if mode not in {"100644", "100755"}:
            reporter.issue("error", path, f"未知のファイルモードです: {mode}")
            continue
        try:
            raw = read_regular(root, path)
            raw.decode("utf-8")
        except (OSError, ValueError) as exc:
            reporter.issue("error", path, f"UTF-8 文書を読み込めません: {exc}")
            continue
        reporter.files += 1
        size = len(raw)
        entry = exceptions.get(path)
        if entry and size <= LIMIT_BYTES:
            reporter.issue("error", path, "使われていない例外です。分割後は例外を削除してください")
        elif entry and size > entry.maximum:
            reporter.issue("error", path, f"{size} バイトは例外の上限 {entry.maximum} を超えています")
        elif size > LIMIT_BYTES and entry is None:
            reporter.issue("error", path, f"{size} バイトです。分割または理由付きの例外が必要です (上限 {LIMIT_BYTES})")
        elif size > REVIEW_BYTES:
            detail = f"例外 {entry.kind}: {entry.reason}" if entry else "目的・読者・主題による分割を検討してください"
            reporter.issue("warning", path, f"{size} バイトです (検討基準 {REVIEW_BYTES})。{detail}")
    print(f"Summary: errors={reporter.errors} warnings={reporter.warnings} files={reporter.files}")
    return int(reporter.errors != 0)


if __name__ == "__main__":
    raise SystemExit(main())
