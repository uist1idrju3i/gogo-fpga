#!/usr/bin/env python3
import argparse
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
MARKER = {"name": "gogo-fpga-placeholder", "content": "main"}
MAX_BYTES = 4096


class PlaceholderParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.marker = False
        self.link = False
        self.text = []
        self.stack = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if len(attributes) != len(attrs):
            raise ValueError("duplicate attributes")
        if tag == "meta":
            allowed = [MARKER, {"charset": "UTF-8"},
                       {"name": "viewport", "content": "width=device-width, initial-scale=1"},
                       {"name": "robots", "content": "noindex"}]
            if attributes not in allowed:
                raise ValueError("unexpected metadata")
            self.marker |= attributes == MARKER
            return
        if tag == "html":
            valid = attributes == {"lang": "ja"}
        elif tag == "a":
            valid = attributes == {"href": "https://fpga.moe/"}
            self.link |= valid
        else:
            valid = tag in {"head", "title", "body", "main", "h1", "p", "code"} and not attrs
        if not valid:
            raise ValueError(f"unexpected element or attributes: {tag}")
        self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack.pop() != tag:
            raise ValueError("unbalanced HTML")

    def handle_data(self, data):
        self.text.append(data)

    def handle_decl(self, decl):
        if decl.lower() != "doctype html":
            raise ValueError("unexpected declaration")


def validate_html(data):
    if not data or len(data) > MAX_BYTES:
        raise ValueError(f"placeholder must be nonempty and at most {MAX_BYTES} bytes")
    parser = PlaceholderParser()
    parser.feed(data.decode("utf-8"))
    parser.close()
    text = "".join(parser.text)
    if (parser.stack or not parser.marker or not parser.link or
            "午後のFPGA" not in text or "pages" not in text):
        raise ValueError("missing placeholder marker, product, branch or canonical link")


def check_repository(root, ref):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(root), *args], stderr=subprocess.PIPE)

    tree = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{tree}}").decode().strip()
    entries = git("ls-tree", "-r", "-z", tree, "--", "public_html").split(b"\0")
    entries = [entry.split(b"\t", 1) for entry in entries if entry]
    if (len(entries) != 1 or entries[0][1] != b"public_html/index.html" or
            not entries[0][0].startswith(b"100644 blob ")):
        raise ValueError("only a regular public_html/index.html placeholder may be tracked")
    path = f"{tree}:public_html/index.html"
    if int(git("cat-file", "-s", path)) > MAX_BYTES:
        raise ValueError("placeholder exceeds size limit")
    validate_html(git("show", path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--ref", default="HEAD")
    args = parser.parse_args()
    try:
        check_repository(args.root, args.ref)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"main placeholder: ERROR: {error}", file=sys.stderr)
        return 1
    print(f"main placeholder: OK ({args.ref})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
