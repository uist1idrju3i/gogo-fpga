import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).resolve().parents[2] / '.github/scripts/check-document-paths.py'
VALUE = '-ffile-prefix-map=/home/test/build=/src'


class DocumentPathTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git('init', '-q')
        self.write('.github/document-path-allowlist.tsv', '# path\tjson_pointer\tvalue_sha256\treason\n')
        self.write('docs/evidence.json', json.dumps({'native': {'flags': VALUE}}) + '\n')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                              capture_output=True)

    def write(self, name, content):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())
        return target

    def exception(self, name='docs/evidence.json', pointer='/native/flags', value=VALUE,
                  reason='Preserve exact compiler flags', digest=None):
        digest = digest if digest is not None else hashlib.sha256(value.encode()).hexdigest()
        return f'{name}\t{pointer}\t{digest}\t{reason}\n'

    def allow(self, **kwargs):
        self.write('.github/document-path-allowlist.tsv', self.exception(**kwargs))

    def check(self, expected=0, contains='errors=0', track=True):
        if track:
            self.git('add', '-A')
        result = subprocess.run([sys.executable, str(CHECKER), '--root', str(self.root)],
                                text=True, capture_output=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertIn(contains, result.stdout)
        self.assertNotIn('Traceback', result.stderr)
        return result.stdout

    def test_no_private_path(self):
        self.write('docs/evidence.json', '{"flags": "-O2"}\n')
        self.check()

    def test_exact_quote_is_not_modified(self):
        original = (self.root / 'docs/evidence.json').read_bytes()
        self.allow()
        self.check(contains='quoted_exceptions=1')
        self.assertEqual((self.root / 'docs/evidence.json').read_bytes(), original)

    def test_unquoted_document_path_fails(self):
        self.allow()
        self.write('README.md', 'See /home/test/build/result.json\n')
        self.check(1, 'README.md:1:')

    def test_unquoted_field_in_same_file_fails(self):
        self.allow()
        self.write('docs/evidence.json', json.dumps({
            'native': {'flags': VALUE}, 'evidence': '/home/test/build/result.json',
        }))
        self.check(1, 'docs/evidence.json:1:')

    def test_home_shorthand_fails(self):
        self.allow()
        self.write('docs/guide.md', 'See ~/work/result.json')
        self.check(1, 'docs/guide.md:1:')

    def test_hash_mismatch_fails(self):
        self.allow(digest='0' * 64)
        self.check(1, 'hash mismatch')

    def test_changed_quote_fails(self):
        self.allow()
        self.write('docs/evidence.json', json.dumps({'native': {'flags': VALUE + ' -O3'}}))
        self.check(1, 'hash mismatch')

    def test_unused_or_missing_exception_fails(self):
        for data in ({}, {'native': {'flags': '-O2'}}, {'native': {'flags': 42}}):
            with self.subTest(data=data):
                self.allow()
                self.write('docs/evidence.json', json.dumps(data))
                self.check(1, 'unused exception')

    def test_missing_pointer_in_matched_file_fails(self):
        self.allow(pointer='/missing/flags')
        self.check(1, '検査に失敗')

    def test_duplicate_exception_fails(self):
        self.write('.github/document-path-allowlist.tsv', self.exception() * 2)
        self.check(1, 'duplicate exception')

    def test_bad_exception_fields_fail(self):
        for kwargs in ({'name': '../evidence.json'}, {'name': '/evidence.json'},
                       {'name': 'docs/*.json'}, {'name': 'docs/evidence.md'},
                       {'reason': ''}, {'digest': 'wrong'}, {'pointer': 'native/flags'},
                       {'pointer': '/native/~3flags'}):
            with self.subTest(kwargs=kwargs):
                self.allow(**kwargs)
                self.check(1, '検査に失敗')

    def test_wrong_column_count_fails(self):
        self.write('.github/document-path-allowlist.tsv', self.exception() + 'too\tfew\n')
        self.check(1, 'exception needs')

    def test_duplicate_json_keys_fail(self):
        self.allow()
        self.write('docs/evidence.json', '{"native":{"flags":' + json.dumps(VALUE) +
                   '},"native":{"flags":' + json.dumps(VALUE) + '}}')
        self.check(1, 'duplicate JSON key')

    def test_ambiguous_string_fails(self):
        self.allow()
        self.write('docs/evidence.json', json.dumps({'native': {'flags': VALUE}, 'copy': VALUE}))
        self.check(1, 'ambiguous quoted value')

    def test_invalid_utf8_and_json_fail(self):
        self.allow()
        for data in (b'/home/test/\xff', '{"native":"/home/test/"'):
            with self.subTest(data=data):
                self.write('docs/evidence.json', data)
                self.check(1, '検査に失敗')

    def test_untracked_evidence_cannot_use_exception(self):
        self.allow()
        self.git('add', '.github')
        self.check(1, 'unused exception', track=False)

    def test_symlink_cannot_use_exception(self):
        self.allow()
        self.write('other.json', json.dumps({'native': {'flags': VALUE}}))
        target = self.root / 'docs/evidence.json'
        target.unlink()
        target.symlink_to('../other.json')
        self.check(1, 'unused exception')

    def test_array_and_escaped_pointer(self):
        self.write('docs/evidence.json', json.dumps({'a/b~c': [VALUE]}))
        self.allow(pointer='/a~1b~0c/0')
        self.check()

    def test_invalid_array_index_fails(self):
        self.write('docs/evidence.json', json.dumps({'flags': [VALUE]}))
        for pointer in ('/flags/-1', '/flags/01', '/flags/2'):
            with self.subTest(pointer=pointer):
                self.allow(pointer=pointer)
                self.check(1, '検査に失敗')

    def test_git_failure_is_not_no_matches(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        self.root = Path(outside.name)
        self.check(1, 'git grep failed', track=False)


if __name__ == '__main__':
    unittest.main()
