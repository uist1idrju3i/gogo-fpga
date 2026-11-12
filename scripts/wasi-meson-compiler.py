#!/usr/bin/env python3
"""Adapt Meson's ELF archive grouping flags to wasm-ld's implicit rescanning."""

import os
import sys


def compiler_arguments(arguments):
    return [item for item in arguments if item not in ("-Wl,--start-group", "-Wl,--end-group")]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Required: compiler [arguments...]")
    os.execv(sys.argv[1], [sys.argv[1], *compiler_arguments(sys.argv[2:])])
