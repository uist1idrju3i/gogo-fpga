#!/usr/bin/env python3
"""Check links and stale documentation paths in tracked repository files."""

from __future__ import annotations

import argparse
import html.parser
import os
import posixpath
import re
import stat
import subprocess
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit


TABLE_PATH = ".github/scripts/data/jisx0213-2004-std.txt"
ALLOWLIST_PATH = ".github/link-check-allowlist.tsv"
FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
ATX_RE = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?)[ \t]*|[ \t]*)$")
STALE_PATH_RE = re.compile(
    r"(?<![\w.\-/])/?docs/[^\s`'\"()\[\]>|,、。）]*"
)
URL_RE = re.compile(r"\b[A-Za-z][A-Za-z0-9+.-]*:[^\s]+")
SCHEME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
PLACEHOLDERS = ("*", "<", "{", "YYYY", "NN")
SKIPPED_STALE_PATHS = {
    ".github/scripts/check-links.py",
    ALLOWLIST_PATH,
}
SKIPPED_STALE_PREFIXES = ("tests/check-links/",)


class Reporter:
    def __init__(self) -> None:
        self.errors = 0
        self.files = 0
        self.links_checked = 0
        self.anchors_checked = 0
        self.stale_paths_checked = 0

    def error(self, path: str, line: int, message: str) -> None:
        print(f"{path}:{line}: error: {message}")
        if os.environ.get("GITHUB_ACTIONS") == "true":
            safe_path = (
                path.replace("%", "%25")
                .replace("\r", "%0D")
                .replace("\n", "%0A")
                .replace(",", "%2C")
            )
            safe_message = (
                message.replace("%", "%25")
                .replace("\r", "%0D")
                .replace("\n", "%0A")
            )
            print(f"::error file={safe_path},line={line}::{safe_message}")
        self.errors += 1

    def summary(self) -> None:
        print(
            "Summary: "
            f"links_checked={self.links_checked} "
            f"anchors_checked={self.anchors_checked} "
            f"stale_paths_checked={self.stale_paths_checked} "
            f"errors={self.errors} files={self.files}"
        )


@dataclass(frozen=True)
class Target:
    value: str
    line: int


@dataclass(frozen=True)
class StalePathException:
    path: str
    token: str
    reason: str
    line: int


def tracked_paths(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), "ls-files", "-z"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "git ls-files failed")
    paths = [os.fsdecode(item).replace(os.sep, "/") for item in result.stdout.split(b"\0") if item]
    return [
        path
        for path in paths
        if not path.startswith("vendor/") and path != TABLE_PATH
    ]


def read_text(root: Path, path: str, reporter: Reporter) -> str | None:
    full_path = root / path
    try:
        mode = full_path.lstat().st_mode
    except OSError as exc:
        reporter.error(path, 1, f"ファイルを確認できません: {exc}")
        return None
    if stat.S_ISLNK(mode) or not stat.S_ISREG(mode):
        return None
    try:
        raw = full_path.read_bytes()
    except OSError as exc:
        reporter.error(path, 1, f"ファイルを読み込めません: {exc}")
        return None
    if b"\0" in raw[:8192]:
        return None
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        line = raw[: exc.start].count(b"\n") + 1
        reporter.error(path, line, "無効な UTF-8 です")
        return None
    reporter.files += 1
    return text


def mask_fenced_code(text: str) -> tuple[str, list[tuple[int, int]]]:
    chars = list(text)
    outside: list[tuple[int, int]] = []
    in_fence: tuple[str, int] | None = None
    offset = 0
    for line in text.splitlines(keepends=True):
        line_end = offset + len(line)
        body = line.rstrip("\r\n")
        match = FENCE_RE.match(body)
        if in_fence is not None:
            chars[offset : offset + len(body)] = [" "] * len(body)
            if match:
                run = match.group(1)
                tail = body[match.end() :]
                if (
                    run[0] == in_fence[0]
                    and len(run) >= in_fence[1]
                    and not tail.strip()
                ):
                    in_fence = None
        elif match:
            chars[offset : offset + len(body)] = [" "] * len(body)
            run = match.group(1)
            in_fence = (run[0], len(run))
        else:
            if outside and outside[-1][1] == offset:
                outside[-1] = (outside[-1][0], line_end)
            else:
                outside.append((offset, line_end))
        offset = line_end
    if not text:
        return "", []
    return "".join(chars), outside


def mask_inline_code(text: str, outside: list[tuple[int, int]]) -> str:
    chars = list(text)
    for start, end in outside:
        segment = text[start:end]
        runs = [
            match
            for match in re.finditer(r"`+", segment)
            if not is_escaped(segment, match.start())
        ]
        index = 0
        while index < len(runs):
            opener = runs[index]
            length = len(opener.group())
            closer_index = next(
                (
                    candidate
                    for candidate in range(index + 1, len(runs))
                    if len(runs[candidate].group()) == length
                ),
                None,
            )
            if closer_index is None:
                index += 1
                continue
            closer = runs[closer_index]
            mask_start = start + opener.start()
            mask_end = start + closer.end()
            chars[mask_start:mask_end] = [" "] * (mask_end - mask_start)
            index = closer_index + 1
    return "".join(chars)


def is_escaped(text: str, index: int) -> bool:
    backslashes = 0
    index -= 1
    while index >= 0 and text[index] == "\\":
        backslashes += 1
        index -= 1
    return backslashes % 2 == 1


def find_link_text_end(text: str, start: int) -> int | None:
    depth = 1
    index = start
    while index < len(text):
        if text[index] == "\\":
            index += 2
            continue
        if text[index] == "[":
            depth += 1
        elif text[index] == "]":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def find_link_end(text: str, opening: int) -> int | None:
    depth = 0
    quote: str | None = None
    index = opening + 1
    while index < len(text):
        char = text[index]
        if char == "\\":
            index += 2
            continue
        if quote is not None:
            if char == quote:
                quote = None
        elif char in {"'", '"'} and (index == opening + 1 or text[index - 1].isspace()):
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                return index
            depth -= 1
        index += 1
    return None


def markdown_destination(content: str) -> tuple[str, int] | None:
    index = 0
    while index < len(content) and content[index].isspace():
        index += 1
    if index == len(content):
        return None
    if content[index] == "<":
        start = index + 1
        index = start
        while index < len(content):
            if content[index] == "\\":
                index += 2
                continue
            if content[index] == ">":
                return content[start:index], start
            index += 1
        return None

    start = index
    depth = 0
    value: list[str] = []
    while index < len(content):
        char = content[index]
        if char == "\\" and index + 1 < len(content):
            value.append(content[index + 1])
            index += 2
            continue
        if char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                break
            depth -= 1
        elif char.isspace() and depth == 0:
            break
        value.append(char)
        index += 1
    if not value:
        return None
    return "".join(value), start


def markdown_links(text: str) -> list[Target]:
    fenced, outside = mask_fenced_code(text)
    masked = mask_inline_code(fenced, outside)
    targets: list[Target] = []
    index = 0
    while index < len(masked):
        if masked[index] != "[" or is_escaped(masked, index):
            index += 1
            continue
        text_end = find_link_text_end(masked, index + 1)
        if text_end is None or text_end + 1 >= len(masked) or masked[text_end + 1] != "(":
            index += 1
            continue
        link_end = find_link_end(masked, text_end + 1)
        if link_end is None:
            index += 1
            continue
        content_start = text_end + 2
        destination = markdown_destination(masked[content_start:link_end])
        if destination is not None:
            value, relative_offset = destination
            offset = content_start + relative_offset
            targets.append(Target(value, text.count("\n", 0, offset) + 1))
        index = link_end + 1
    return targets


def srcset_urls(value: str) -> list[str]:
    urls: list[str] = []
    index = 0
    while index < len(value):
        while index < len(value) and (value[index].isspace() or value[index] == ","):
            index += 1
        start = index
        while index < len(value) and not value[index].isspace():
            index += 1
        url = value[start:index].rstrip(",")
        if url:
            urls.append(url)
        while index < len(value) and value[index] != ",":
            index += 1
    return urls


class MarkdownHTMLParser(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.targets: list[Target] = []
        self.anchors: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_tag(tag, attrs)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self._handle_tag(tag, attrs)

    def _handle_tag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line = self.getpos()[0]
        values = {name.lower(): value for name, value in attrs}
        if tag.lower() == "a":
            for name in ("id", "name"):
                if values.get(name):
                    self.anchors.add(values[name] or "")
        for name in ("src", "href"):
            value = values.get(name)
            if value:
                self.targets.append(Target(value, line))
        srcset = values.get("srcset")
        if srcset:
            self.targets.extend(Target(value, line) for value in srcset_urls(srcset))


def markdown_anchors(text: str) -> set[str]:
    fenced, outside = mask_fenced_code(text)
    anchors: set[str] = set()
    duplicate_counts: dict[str, int] = {}
    for line in fenced.splitlines(keepends=True):
        match = ATX_RE.match(line.rstrip("\r\n"))
        if match:
            heading = match.group(2) or ""
            heading = re.sub(r"[ \t]+#+[ \t]*$", "", heading)
            base = heading_slug(heading)
            if base:
                duplicate = duplicate_counts.get(base, 0)
                duplicate_counts[base] = duplicate + 1
                anchors.add(base if duplicate == 0 else f"{base}-{duplicate}")
    masked = mask_inline_code(fenced, outside)
    parser = MarkdownHTMLParser()
    parser.feed(masked)
    anchors.update(parser.anchors)
    return anchors


def heading_slug(text: str) -> str:
    value = text.lower()
    value = re.sub(r"[*~`]+", "", value)
    value = re.sub(r"(?<!\w)_+|_+(?!\w)", "", value)
    filtered: list[str] = []
    for char in value:
        category = unicodedata.category(char)
        if category[0] in {"L", "N"} or char in {" ", "-", "_"} or char.isspace():
            filtered.append(" " if char.isspace() else char)
    return re.sub(r"\s+", "-", "".join(filtered)).strip("-")


def external_target(value: str) -> bool:
    value = value.strip()
    return bool(SCHEME_RE.match(value)) or value.startswith("//")


def tracked_directory(path: str, tracked: set[str]) -> bool:
    prefix = path.rstrip("/") + "/"
    return any(item.startswith(prefix) for item in tracked)


def resolved_target(source: str, value: str) -> tuple[str, str]:
    parsed = urlsplit(value.strip())
    path = unquote(parsed.path)
    fragment = unquote(parsed.fragment)
    if path.startswith("/"):
        normalized = posixpath.normpath(path.lstrip("/"))
    elif path:
        normalized = posixpath.normpath(
            posixpath.join(posixpath.dirname(source), path)
        )
    else:
        normalized = source
    if normalized == ".":
        normalized = ""
    return normalized, fragment


def validate_target(
    source: str,
    target: Target,
    tracked: set[str],
    anchors_by_path: dict[str, set[str]],
    reporter: Reporter,
) -> None:
    reporter.links_checked += 1
    if external_target(target.value):
        return
    resolved, fragment = resolved_target(source, target.value)
    if resolved not in tracked and not tracked_directory(resolved, tracked):
        reporter.error(source, target.line, f"リンク先が追跡対象にありません: {target.value}")
        return
    if fragment and resolved.lower().endswith(".md"):
        reporter.anchors_checked += 1
        anchors = anchors_by_path.get(resolved)
        if anchors is None:
            return
        if fragment not in anchors:
            reporter.error(
                source,
                target.line,
                f"リンク先の見出しアンカーがありません: {target.value}",
            )


def stale_path_exists(value: str, tracked: set[str]) -> bool:
    path = value.rstrip(".:;")
    path = re.split(r"[?#]", path, maxsplit=1)[0]
    path = path.lstrip("/")
    if path in {"docs", "docs/"}:
        return True
    parts = [part for part in path.split("/") if part]
    placeholder_index = next(
        (
            index
            for index, part in enumerate(parts)
            if any(marker in part for marker in PLACEHOLDERS)
        ),
        None,
    )
    if placeholder_index is not None:
        prefix = "/".join(parts[:placeholder_index])
        if prefix == "docs":
            return True
        return bool(prefix) and tracked_directory(prefix, tracked)
    normalized = posixpath.normpath(path)
    return normalized in tracked or tracked_directory(normalized, tracked)


def load_stale_path_allowlist(
    text: str, tracked: set[str], reporter: Reporter
) -> list[StalePathException]:
    entries: list[StalePathException] = []
    for number, line in enumerate(text.splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) != 3:
            reporter.error(
                ALLOWLIST_PATH,
                number,
                "例外一覧の形式が不正です（TSV の3列が必要です）",
            )
            continue
        path, token, reason = fields
        if not path or not token or not reason.strip():
            reporter.error(
                ALLOWLIST_PATH,
                number,
                "例外一覧の path、token、reason は空にできません",
            )
            continue
        if path not in tracked:
            reporter.error(
                ALLOWLIST_PATH,
                number,
                f"例外の対象ファイルが追跡対象にありません: {path}",
            )
            continue
        entries.append(StalePathException(path, token, reason, number))
    return entries


def check_stale_paths(
    paths: list[str],
    texts: dict[str, str],
    tracked: set[str],
    reporter: Reporter,
) -> None:
    if ALLOWLIST_PATH not in tracked:
        reporter.error(ALLOWLIST_PATH, 1, "例外一覧が追跡対象にありません")
        return
    allowlist_text = texts.get(ALLOWLIST_PATH)
    if allowlist_text is None:
        reporter.error(ALLOWLIST_PATH, 1, "例外一覧を読み込めません")
        return
    exceptions = load_stale_path_allowlist(allowlist_text, tracked, reporter)
    used_exceptions: set[int] = set()

    for path in paths:
        if path in SKIPPED_STALE_PATHS or path.startswith(SKIPPED_STALE_PREFIXES):
            continue
        text = texts.get(path)
        if text is None:
            continue
        for line_number, line in enumerate(text.splitlines(), 1):
            urls = [match.span() for match in URL_RE.finditer(line)]
            for match in STALE_PATH_RE.finditer(line):
                if any(start <= match.start() < end for start, end in urls):
                    continue
                reporter.stale_paths_checked += 1
                value = match.group(0)
                token = value.rstrip(".:;")
                exception_index = next(
                    (
                        index
                        for index, entry in enumerate(exceptions)
                        if entry.path == path
                        and (
                            token == entry.token
                            or (
                                entry.token.endswith("/")
                                and token.startswith(entry.token)
                            )
                        )
                    ),
                    None,
                )
                if exception_index is not None:
                    used_exceptions.add(exception_index)
                    continue
                if not stale_path_exists(value, tracked):
                    reporter.error(
                        path,
                        line_number,
                        f"古い文書パスが追跡対象にありません: {value}",
                    )

    for index, entry in enumerate(exceptions):
        if index not in used_exceptions:
            reporter.error(
                ALLOWLIST_PATH,
                entry.line,
                f"使われていない例外: {entry.path} {entry.token}",
            )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument(
        "--links-only",
        action="store_true",
        help="check Markdown links and anchors without scanning stale paths",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    reporter = Reporter()
    try:
        paths = tracked_paths(root)
    except RuntimeError as exc:
        reporter.error("git", 1, str(exc))
        reporter.summary()
        return 2

    tracked = set(paths)
    texts: dict[str, str] = {}
    markdown: dict[str, str] = {}
    for path in paths:
        text = read_text(root, path, reporter)
        if text is None:
            continue
        texts[path] = text
        if path.lower().endswith(".md"):
            markdown[path] = text

    anchors_by_path = {
        path: markdown_anchors(text)
        for path, text in markdown.items()
    }
    for path, text in markdown.items():
        fenced, outside = mask_fenced_code(text)
        masked = mask_inline_code(fenced, outside)
        html_parser = MarkdownHTMLParser()
        html_parser.feed(masked)
        targets = markdown_links(text) + html_parser.targets
        for target in targets:
            validate_target(path, target, tracked, anchors_by_path, reporter)

    if not args.links_only:
        check_stale_paths(paths, texts, tracked, reporter)
    reporter.summary()
    return 1 if reporter.errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
