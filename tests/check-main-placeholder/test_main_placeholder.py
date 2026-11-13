import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "main_placeholder", ROOT / ".github/scripts/check-main-placeholder.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
PLACEHOLDER = '''<!doctype html><html lang="ja"><head>
<meta name="gogo-fpga-placeholder" content="main"></head><body>
<h1>午後のFPGA</h1><p>pages</p>
<a href="https://fpga.moe/">Open</a></body></html>'''.encode("utf-8")


class PlaceholderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-q", "-b", "test")
        (self.root / "public_html").mkdir()
        self.index = self.root / "public_html/index.html"

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args],
                                       stderr=subprocess.PIPE).decode().strip()

    def tree(self, content=PLACEHOLDER):
        self.index.write_bytes(content)
        self.git("add", "public_html")
        return self.git("write-tree")

    def test_valid_tree_and_generated_worktree_are_independent(self):
        tree = self.tree()
        self.index.write_text('<script src="app.js"></script>')
        CHECK.check_repository(self.root, tree)
        result = subprocess.run([sys.executable, str(SPEC.origin), "--root", str(self.root),
                                 "--ref", tree], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("main placeholder: OK", result.stdout)

    def test_invalid_commit_cannot_be_hidden_by_worktree(self):
        tree = self.tree(PLACEHOLDER + b'<script src="app.js"></script>')
        self.index.write_bytes(PLACEHOLDER)
        result = subprocess.run([sys.executable, str(SPEC.origin), "--root", str(self.root),
                                 "--ref", tree], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("main placeholder: ERROR", result.stderr)

    def test_empty_tree_and_missing_ref_fail_closed(self):
        with self.assertRaises(ValueError):
            CHECK.check_repository(self.root, self.git("write-tree"))
        with self.assertRaises(subprocess.CalledProcessError):
            CHECK.check_repository(self.root, "missing")

    def test_real_application_cannot_be_committed(self):
        with self.assertRaises(ValueError):
            CHECK.check_repository(self.root, self.tree((ROOT / "web/index.html").read_bytes()))

    def test_marker_does_not_allow_active_content(self):
        for suffix in [b'<script src="app.js"></script>', b'<script>run()</script>',
                       b'<link rel="stylesheet" href="style.css">',
                       b'<iframe src="https://example.com"></iframe>',
                       b'<a href="https://fpga.moe/" onclick="run()">Open</a>']:
            with self.subTest(suffix=suffix), self.assertRaises(ValueError):
                CHECK.check_repository(self.root, self.tree(PLACEHOLDER + suffix))

    def test_missing_required_content_and_invalid_bytes(self):
        for content in [b"", b"\xff", b"x" * 4097,
                        PLACEHOLDER.replace(b'gogo-fpga-placeholder', b'other-marker'),
                        PLACEHOLDER.replace(b'pages', b'main'),
                        PLACEHOLDER.replace(b'https://fpga.moe/', b'https://example.com/'),
                        PLACEHOLDER.replace(b'</html>', b'')]:
            with self.subTest(content=content[:50]), self.assertRaises(ValueError):
                CHECK.check_repository(self.root, self.tree(content))

    def test_other_tracked_output_is_rejected(self):
        self.tree()
        (self.root / "public_html/app.js").write_text("generated")
        with self.assertRaises(ValueError):
            CHECK.check_repository(self.root, self.tree())

    def test_symlink_is_rejected(self):
        (self.root / "placeholder.html").write_bytes(PLACEHOLDER)
        self.index.symlink_to("../placeholder.html")
        self.git("add", "public_html", "placeholder.html")
        with self.assertRaises(ValueError):
            CHECK.check_repository(self.root, self.git("write-tree"))


if __name__ == "__main__":
    unittest.main()
