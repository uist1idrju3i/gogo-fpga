import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pins = load("pins", ".github/scripts/check-pins.py")
formal = load("formal", "scripts/prepare-formal-sources.py")


class FormalPinsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.modules = []
        rows = ["| 依存 | 版 | commit | 取得元 |", "|---|---|---|---|"]
        for name, license_file in pins.FORMAL_SOURCES.items():
            version = {"sby": "snapshot", "z3": "z3-1.2.3", "yices2": "yices-1.2.3"}.get(name, "1.2.3")
            url = f"https://example.invalid/{name}.git"
            rows.append(f"| {name} | {version} | `{'a' * 40}` | {url} |")
            directory = self.root / "vendor" / name
            directory.mkdir(parents=True)
            (directory / license_file).write_text("Original license\n")
            self.modules.append({"path": f"vendor/{name}", "url": url})
        (self.root / "RESEARCH.md").write_text("\n".join(rows) + "\n")
        for notice in ("NOTICE", "THIRD_PARTY_NOTICES.md"):
            (self.root / notice).write_text(" ".join(pins.FORMAL_SOURCES))

    def test_sources_and_original_licenses_are_required(self):
        self.assertEqual(pins.formal_source_errors(self.root, self.modules), [])
        (self.root / "vendor/sby/COPYING").unlink()
        self.assertTrue(any("missing formal source license" in error for error in pins.formal_source_errors(self.root, self.modules)))

    def test_missing_source_and_changed_url_are_rejected(self):
        self.assertEqual(len(pins.formal_source_errors(self.root, [])), 6)
        self.modules[0]["url"] = "https://example.invalid/wrong.git"
        self.modules.pop()
        errors = pins.formal_source_errors(self.root, self.modules)
        self.assertEqual(sum("URL differs" in error for error in errors), 2)

    def test_missing_notice_is_rejected(self):
        for notice in ("NOTICE", "THIRD_PARTY_NOTICES.md"):
            with self.subTest(notice=notice):
                original = (self.root / notice).read_text()
                (self.root / notice).write_text("")
                self.assertTrue(any(notice in error for error in pins.formal_source_errors(self.root, self.modules)))
                (self.root / notice).write_text(original)

    def test_wrong_commit_and_tag_are_rejected(self):
        text = (self.root / "RESEARCH.md").read_text()
        for invalid in (text.replace("a" * 40, "a" * 8), text.replace("yices-1.2.3", "v1.2.3"), text.replace("| click |", "| missing |")):
            with self.subTest(text=invalid), self.assertRaises(RuntimeError):
                pins.parse_formal_pins(invalid)

    def test_archive_index_uses_latest_stable_across_majors(self):
        index = ''.join(f'<a href="gmp-{version}.tar.xz">archive</a>' for version in ("6.9.0", "6.10.0", "7.0.0", "8.0.0-rc1"))
        self.assertEqual(pins.latest_archive_version(index, "gmp"), "7.0.0")
        with self.assertRaises(RuntimeError):
            pins.latest_archive_version("temporary error", "gmp")


class FormalArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "gmp-0.0.1.tar.xz"
        self.pin = {"version": "0.0.1", "asset": self.archive.name, "url": "https://example.invalid/gmp.tar.xz"}

    def make_archive(self, extra=None, missing=None):
        with tarfile.open(self.archive, "w:xz") as archive:
            for name in formal.LICENSE_FILES:
                if name == missing:
                    continue
                data = (name + " original\n").encode()
                member = tarfile.TarInfo(f"gmp-0.0.1/{name}")
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(b""))
        self.pin["sha256"] = hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_hash_and_missing_license_are_rejected(self):
        self.make_archive()
        self.pin["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            formal.verify_archive(self.archive, self.pin)
        self.make_archive(missing="COPYINGv3")
        with self.assertRaisesRegex(ValueError, "Missing GMP source license"):
            formal.verify_archive(self.archive, self.pin)

    def test_unsafe_paths_and_duplicates_are_rejected(self):
        for name in ("/absolute", "gmp-0.0.1/../../escape", "gmp-0.0.1/.git/config", "gmp-0.0.1/COPYING"):
            with self.subTest(name=name):
                self.make_archive(tarfile.TarInfo(name))
                with self.assertRaises(ValueError):
                    formal.verify_archive(self.archive, self.pin)

    def test_symlink_escape_and_special_file_are_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                member = tarfile.TarInfo("gmp-0.0.1/unsafe")
                member.type = kind
                member.linkname = "../../outside"
                self.make_archive(member)
                with self.assertRaises(ValueError):
                    formal.verify_archive(self.archive, self.pin)

    def test_git_free_source_reuses_exact_archive_and_original_licenses(self):
        self.make_archive()
        source = self.root / "vendor/formal-archives"
        source.mkdir(parents=True)
        original = self.archive.read_bytes()
        (source / self.archive.name).write_bytes(original)
        output = self.root / "staged"
        with patch.object(formal, "archive_pin", return_value=self.pin), patch.object(formal.urllib.request, "urlopen", side_effect=AssertionError("Unexpected network")):
            formal.prepare(self.root, output)
            self.assertEqual((output / self.archive.name).read_bytes(), original)
            self.assertEqual(json.loads((output / "manifest.json").read_text()), {"gmp": self.pin})
            for name in formal.LICENSE_FILES:
                self.assertEqual((output / "licenses" / f"gmp-{name}").read_bytes(), (name + " original\n").encode())
            with self.assertRaisesRegex(ValueError, "already exists"):
                formal.prepare(self.root, output)

    def test_existing_output_symlink_is_rejected(self):
        output = self.root / "linked"
        output.symlink_to(self.root / "absent")
        with self.assertRaisesRegex(ValueError, "already exists"):
            formal.prepare(self.root, output)


if __name__ == "__main__":
    unittest.main()
