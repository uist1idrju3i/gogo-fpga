#!/bin/sh
set -eu

repo_root="$(CDPATH='' cd "$(dirname "$0")/../.." && pwd)"
checker="$repo_root/.github/scripts/check-links.py"
test_root="$(mktemp -d)"
fixture="$test_root/repo"

cleanup() {
	rm -rf "$test_root"
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

fail() {
	printf 'not ok - %s\n' "$*" >&2
	exit 1
}

new_repo() {
	rm -rf "$fixture"
	mkdir -p "$fixture"
	git -C "$fixture" init -q
	write_file .github/link-check-allowlist.tsv '# path	token	reason
'
}

write_file() {
	file="$fixture/$1"
	mkdir -p "$(dirname "$file")"
	printf '%s' "$2" > "$file"
}

track_files() {
	git -C "$fixture" add -A
}

run_check() {
	if output="$(python3 "$checker" --root "$fixture" 2>&1)"; then
		status=0
	else
		status=$?
	fi
}

expect_status() {
	expected="$1"
	[ "$status" -eq "$expected" ] || fail "expected exit $expected, got $status: $output"
}

expect_output() {
	needle="$1"
	case "$output" in
		*"$needle"*) ;;
		*) fail "output did not contain $needle: $output" ;;
	esac
}

new_repo
write_file README.md '# 日本語見出し

[ページ](docs/page.md#日本語見出し)
[root](/docs/page.md#日本語見出し)
[query](docs/page.md?raw=1#日本語見出し)
[directory](docs/)
[external](https://example.com/docs/x)
[email](mailto:help@example.com)
![画像](docs/image.svg)
<img src="docs/image.svg">
<source srcset="docs/one.svg 1x, docs/two.svg 2x">
'
write_file docs/page.md '# 日本語見出し
'
write_file docs/image.svg '<svg/>'
write_file docs/one.svg '<svg/>'
write_file docs/two.svg '<svg/>'
track_files
run_check
expect_status 0
expect_output 'links_checked=10'
expect_output 'anchors_checked=3'
printf 'ok - accepts tracked Markdown, HTML, srcset, and Japanese anchors\n'

new_repo
write_file README.md '[broken](missing.md)
'
track_files
run_check
expect_status 1
expect_output 'missing.md'
printf 'ok - rejects a broken relative Markdown link\n'

new_repo
write_file README.md '<img src="missing.png">
<img srcset="missing-1.png 1x, missing-2.png 2x">
'
track_files
run_check
expect_status 1
expect_output 'missing.png'
expect_output 'missing-1.png'
expect_output 'missing-2.png'
printf 'ok - rejects missing HTML src and srcset targets\n'

new_repo
write_file README.md '[missing](page.md#not-there)
'
write_file page.md '# 日本語見出し
'
track_files
run_check
expect_status 1
expect_output 'リンク先の見出しアンカーがありません'
printf 'ok - rejects a missing heading anchor\n'

new_repo
write_file README.md '[valid](page.md#日本語見出し)
'
write_file page.md '# 日本語見出し
'
track_files
run_check
expect_status 0
expect_output 'anchors_checked=1'
printf 'ok - accepts a valid Japanese heading anchor\n'

new_repo
write_file README.md '# Repeat
# Repeat
<a id="manual-id"></a>
<a name="manual-name"></a>
[duplicate](#repeat-1) [id](#manual-id) [name](#manual-name)
'
track_files
run_check
expect_status 0
expect_output 'anchors_checked=3'
printf 'ok - checks duplicate heading slugs and explicit HTML anchors\n'

new_repo
write_file .github/workflows/example.yml '# docs/foo.md is stale
'
track_files
run_check
expect_status 1
expect_output 'docs/foo.md'
printf 'ok - detects stale docs paths in non-Markdown text\n'

new_repo
write_file docs/research/sources.md 'recorded title: docs/external-repository/asciidoc/computers/config_txt/autoboot.adoc;
'
write_file .github/link-check-allowlist.tsv '# path	token	reason
docs/research/sources.md	docs/external-repository/asciidoc/computers/config_txt/autoboot.adoc	external repository page title
'
track_files
run_check
expect_status 0
printf 'ok - accepts an explicitly allowlisted external repository path\n'

new_repo
write_file docs/research/sources.md 'recorded title: docs/external-repository/asciidoc/computers/config_txt/autoboot.adoc;
'
track_files
run_check
expect_status 1
expect_output 'docs/external-repository/asciidoc/computers/config_txt/autoboot.adoc'
printf 'ok - rejects the same external path without an allowlist entry\n'

new_repo
write_file docs/research/sources.md 'docs/research/README.md
'
write_file docs/research/README.md 'tracked
'
write_file .github/link-check-allowlist.tsv '# path	token	reason
docs/research/sources.md	docs/external-repository/	unused external path
'
track_files
run_check
expect_status 1
expect_output '使われていない例外'
printf 'ok - rejects an unused allowlist entry\n'

new_repo
write_file docs/research/sources.md 'recorded title
'
write_file .github/link-check-allowlist.tsv '# path	token	reason
docs/research/missing.md	docs/external-repository/	untracked source
'
track_files
run_check
expect_status 1
expect_output '例外の対象ファイルが追跡対象にありません'
printf 'ok - rejects an allowlist entry for an untracked file\n'

new_repo
write_file docs/experiments/README.md 'placeholder directory
'
write_file .github/workflows/example.yml 'path: docs/experiments/YYYY-MM-DD-sNN-<short>.md
template: docs/experiments/S<番号><英字>-<short>.md
record: docs/experiments/README.md;
pattern: docs/*
'
track_files
run_check
expect_status 0
expect_output 'errors=0'
printf 'ok - accepts placeholders and docs/* patterns\n'

new_repo
write_file .github/workflows/example.yml 'kernel: https://docs.kernel.org/x
example: https://example.com/docs/x
'
track_files
run_check
expect_status 0
printf 'ok - ignores documentation-like paths inside URLs\n'

new_repo
write_file README.md '```markdown
[fenced](missing.md)
```

`[inline](missing-inline.md)
continued`
'
track_files
run_check
expect_status 0
expect_output 'links_checked=0'
printf 'ok - ignores links in fenced and multiline inline code\n'

printf 'All check-links tests passed.\n'
