#!/bin/sh
set -eu
root="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
exec python3 "$root/tests/check-document-size/test_checker.py"
