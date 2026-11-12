#!/bin/sh
set -eu

root="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
python3 -m unittest discover -s tests/check-pins -p 'test_*.py' -v
