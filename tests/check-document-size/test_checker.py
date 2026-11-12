import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import importlib.util


CHECKER = Path(__file__).resolve().parents[2] / '.github/scripts/check-document-size.py'
SPEC = importlib.util.spec_from_file_location('document_size', CHECKER)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class DocumentSizeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git('init', '-q')
        self.write('.github/document-size-allowlist.tsv', '# path\tkind\tmax_bytes\treason\n')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode())
        return path

    def check(self, status=0, contains='errors=0', track=True):
        if track:
            self.git('add', '-A')
        env = {**os.environ, 'GITHUB_ACTIONS': 'false'}
        result = subprocess.run([sys.executable, str(CHECKER), '--root', str(self.root)],
                                text=True, capture_output=True, env=env)
        self.assertEqual(result.returncode, status, result.stdout + result.stderr)
        self.assertIn(contains, result.stdout)
        self.assertNotIn('Traceback', result.stderr)
        return result.stdout

    def exception(self, name='README.md', kind='indivisible-record', maximum='45000', reason='保持する原典'):
        return f'{name}\t{kind}\t{maximum}\t{reason}\n'

    def test_boundaries(self):
        for size, status, expected in [(20000, 0, 'warnings=0'), (20001, 0, 'warnings=1'),
                                       (40000, 0, 'warnings=1'), (40001, 1, '分割または理由付き')]:
            with self.subTest(size=size):
                self.write('README.md', 'a' * size)
                self.check(status, expected)

    def test_utf8_bytes_not_characters(self):
        self.write('README.md', 'あ' * 6667)
        self.check(0, '20001 バイト')

    def test_markdown_case_and_extension(self):
        self.write('README.MD', 'a' * 20001)
        self.write('guide.markdown', 'a' * 20001)
        self.check(0, 'warnings=2 files=2')

    def test_untracked_and_non_markdown_ignored(self):
        self.write('README.md', 'short')
        self.write('data.csv', 'a' * 40001)
        self.git('add', '-A')
        self.write('untracked.md', 'a' * 40001)
        self.check(0, 'warnings=0 files=1', track=False)

    def test_accepts_exception_kinds_at_limit(self):
        self.write('README.md', 'a' * 45000)
        for kind in MODULE.KINDS:
            with self.subTest(kind=kind):
                self.write('.github/document-size-allowlist.tsv', self.exception(kind=kind))
                self.check(0, f'例外 {kind}')

    def test_rejects_exception_limit_exceeded(self):
        self.write('README.md', 'a' * 45001)
        self.write('.github/document-size-allowlist.tsv', self.exception())
        self.check(1, '例外の上限 45000')

    def test_unused_exception(self):
        self.write('README.md', 'a' * 40000)
        self.write('.github/document-size-allowlist.tsv', self.exception())
        self.check(1, '使われていない例外')

    def test_missing_target(self):
        self.write('.github/document-size-allowlist.tsv', self.exception())
        self.check(1, '対象が追跡した通常のファイルではありません')

    def test_duplicate_exception(self):
        self.write('README.md', 'a' * 40001)
        self.write('.github/document-size-allowlist.tsv', self.exception() * 2)
        self.check(1, '重複')

    def test_malformed_exception_fields(self):
        self.write('README.md', 'a' * 40001)
        cases = [(self.exception(kind='ordinary'), '種別または理由'),
                 (self.exception(reason=' '), '種別または理由'),
                 (self.exception().rstrip('\n') + '\tunexpected\n', '列数'),
                 ('README.md\tlicense\t45000\n', '列数')]
        for line, expected in cases:
            with self.subTest(line=line):
                self.write('.github/document-size-allowlist.tsv', line)
                self.check(1, expected)

    def test_invalid_exception_paths(self):
        for name in ['*.md', '../README.md', '/README.md', './README.md', 'guide//README.md',
                     'guide/../README.md', 'guide\\README.md', 'data.csv', '']:
            with self.subTest(name=name):
                self.write('.github/document-size-allowlist.tsv', self.exception(name=name))
                self.check(1, '正確な相対 Markdown パス')

    def test_invalid_exception_maximum(self):
        self.write('README.md', 'a' * 40001)
        for maximum in ['40000', '0', '-1', '+45000', '45_000', '4.5e4', '45000 ', '']:
            with self.subTest(maximum=maximum):
                self.write('.github/document-size-allowlist.tsv', self.exception(maximum=maximum))
                self.check(1, '例外の上限は')

    def test_invalid_utf8(self):
        self.write('README.md', b'bad\xff')
        self.check(1, 'UTF-8 文書を読み込めません')

    def test_missing_tracked_file(self):
        p = self.write('README.md', 'short')
        self.git('add', '-A')
        p.unlink()
        self.check(1, '読み込めません', track=False)

    def test_changed_file_type(self):
        p = self.write('README.md', 'short')
        self.git('add', '-A')
        p.unlink()
        p.mkdir()
        self.check(1, '通常のファイルではありません', track=False)

    def test_unreadable_file(self):
        with patch.object(Path, 'read_bytes', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                MODULE.read_regular(self.root, '.github/document-size-allowlist.tsv')

    def test_missing_config(self):
        (self.root / '.github/document-size-allowlist.tsv').unlink()
        self.write('README.md', 'short')
        self.check(1, '例外リストが追跡した通常のファイルではありません')

    def test_invalid_config_encoding(self):
        self.write('.github/document-size-allowlist.tsv', b'bad\xff')
        self.check(1, 'error:')

    def test_tracked_symlinks_and_gitlinks_are_not_followed(self):
        self.write('README.md', 'short')
        (self.root / 'mirror.md').symlink_to('README.md')
        (self.root / 'missing.md').symlink_to('absent')
        self.git('add', '-A')
        self.git('update-index', '--add', '--cacheinfo', '160000,' + '1' * 40 + ',nested.md')
        self.check(0, 'files=1', track=False)

    def test_exception_cannot_target_symlink(self):
        self.write('README.md', 'a' * 40001)
        (self.root / 'mirror.md').symlink_to('README.md')
        self.write('.github/document-size-allowlist.tsv', self.exception(name='mirror.md'))
        self.check(1, '対象が追跡した通常のファイルではありません')

    def test_exception_cannot_target_gitlink(self):
        self.write('.github/document-size-allowlist.tsv', self.exception(name='nested.md'))
        self.git('add', '-A')
        self.git('update-index', '--add', '--cacheinfo', '160000,' + '1' * 40 + ',nested.md')
        self.check(1, '対象が追跡した通常のファイルではありません', track=False)

    def test_symlink_parent_rejected(self):
        self.write('guide/README.md', 'short')
        self.git('add', '-A')
        (self.root / 'guide/README.md').unlink()
        (self.root / 'guide').rmdir()
        with tempfile.TemporaryDirectory() as outside:
            Path(outside, 'README.md').write_text('not part of repository')
            (self.root / 'guide').symlink_to(outside, target_is_directory=True)
            self.check(1, 'シンボリックリンクを経由', track=False)

    def test_config_symlink_rejected(self):
        self.write('config.tsv', '# config')
        (self.root / '.github/document-size-allowlist.tsv').unlink()
        (self.root / '.github/document-size-allowlist.tsv').symlink_to('../config.tsv')
        self.check(1, '例外リストが追跡した通常のファイルではありません')

    def test_git_failure(self):
        with patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 128, b'', b'not a git repository')):
            with self.assertRaisesRegex(ValueError, 'not a git repository'):
                MODULE.tracked_modes(self.root)

    def test_unmerged_index(self):
        conflict = b'100644 ' + b'1' * 40 + b' 2\tREADME.md\0'
        with patch.object(MODULE.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, conflict, b'')):
            with self.assertRaisesRegex(ValueError, 'Unmerged'):
                MODULE.tracked_modes(self.root)


if __name__ == '__main__':
    unittest.main()
