#!/usr/bin/env python3
import argparse
import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
MAX_PAGES = 30
MAX_NOTES = 100
MAX_NOTE_CHARS = 10000


def object_fields(value, required, optional, location):
    if not isinstance(value, dict) or not required <= value.keys() or value.keys() - required - optional:
        raise ValueError(f"{location}: missing or unknown fields, or expected object")


def text(value, location):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{location}: expected nonempty string")


def notes(value, location):
    if not isinstance(value, list):
        raise ValueError(f"{location}: expected array")
    for index, note in enumerate(value):
        label = f"{location}[{index}]"
        object_fields(note, {"content"}, {"author"}, label)
        text(note["content"], label + ".content")
        if len(note["content"]) > MAX_NOTE_CHARS:
            raise ValueError(f"{label}: note exceeds {MAX_NOTE_CHARS} characters")
        if "author" in note:
            text(note["author"], label + ".author")
    return len(value)


def validate(config):
    object_fields(config, {"repo_notes", "pages"}, set(), "config")
    count = notes(config["repo_notes"], "repo_notes")
    pages = config["pages"]
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_PAGES:
        raise ValueError(f"pages: expected 1 to {MAX_PAGES} pages")
    parents = {}
    for index, page in enumerate(pages):
        label = f"pages[{index}]"
        object_fields(page, {"title", "purpose"}, {"parent", "page_notes"}, label)
        text(page["title"], label + ".title")
        text(page["purpose"], label + ".purpose")
        title = page["title"]
        if title != title.strip() or title in parents:
            raise ValueError(f"{label}: duplicate title or surrounding whitespace")
        parent = page.get("parent")
        if parent is not None:
            text(parent, label + ".parent")
        parents[title] = parent
        count += notes(page.get("page_notes", []), label + ".page_notes")
    if count > MAX_NOTES:
        raise ValueError(f"notes: total exceeds {MAX_NOTES}")
    for title in parents:
        seen = set()
        node = title
        while node is not None:
            if node not in parents:
                raise ValueError(f"{title}: unknown parent {node!r}")
            if node in seen:
                raise ValueError(f"{title}: parent cycle")
            seen.add(node)
            node = parents[node]
    return len(pages), count


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"invalid JSON constant: {value}")


def load_config(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_object,
                      parse_constant=reject_constant)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path", nargs="?", type=Path, default=ROOT / ".devin/wiki.json")
    args = parser.parse_args()
    try:
        pages, count = validate(load_config(args.path))
    except (OSError, ValueError, RecursionError) as error:
        print(f"DeepWiki config: ERROR: {error}", file=sys.stderr)
        return 1
    print(f"DeepWiki config: OK ({pages}/{MAX_PAGES} pages, {count}/{MAX_NOTES} notes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
