import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("formal_solvers", ROOT / "scripts/build-formal-solvers.py")
SOLVERS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SOLVERS)


class SolverSourceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.snapshot = SOLVERS.source_snapshot(ROOT)
        for name in ("RESEARCH.md", ".github/scripts/check-pins.py"):
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        upstream = self.root / "vendor/yices2"
        upstream.mkdir(parents=True)
        data = subprocess.check_output(["git", "-C", str(ROOT / "vendor/yices2"), "archive", self.snapshot["pin"]["commit"]])
        with tarfile.open(fileobj=io.BytesIO(data)) as stream:
            stream.extractall(upstream, filter="data")
        (upstream / ".gitcommit").write_text(self.snapshot["pin"]["commit"] + "\n")
        (self.root / SOLVERS.SNAPSHOT).write_bytes(SOLVERS.encoded(self.snapshot))

    def test_git_free_inventory_matches_pinned_git_archive_without_using_git(self):
        with patch.object(SOLVERS.subprocess, "check_output", side_effect=AssertionError("No Git allowed")):
            self.assertEqual(SOLVERS.source_snapshot(self.root), self.snapshot)

    def test_modified_missing_extra_and_linked_source_are_rejected(self):
        source = self.root / "vendor/yices2/LICENSE.txt"
        original = source.read_bytes()
        source.write_bytes(original + b"modified")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            SOLVERS.source_snapshot(self.root)
        source.unlink()
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            SOLVERS.source_snapshot(self.root)
        source.symlink_to(ROOT / "vendor/yices2/LICENSE.txt")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            SOLVERS.source_snapshot(self.root)
        source.unlink()
        source.write_bytes(original)
        (source.parent / "extra.c").write_bytes(b"extra")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            SOLVERS.source_snapshot(self.root)

    def test_wrong_source_pin_and_invalid_provenance_are_rejected(self):
        for change in ({"format_version": True}, {"pin": {}}, {"files": {}}, {"files": {"../escape": {}}}):
            with self.subTest(change=change):
                (self.root / SOLVERS.SNAPSHOT).write_bytes(SOLVERS.encoded({**self.snapshot, **change}))
                with self.assertRaises(ValueError):
                    SOLVERS.source_snapshot(self.root)


class SolverBundleTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        fixture = patch.object(SOLVERS, "inputs", return_value={"fixture": True})
        fixture.start()
        self.addCleanup(fixture.stop)
        self.wasm = b"\x00asm\x01\x00\x00\x00"
        self.entry = {"path": "yices2.wasm", "size": len(self.wasm), "sha256": SOLVERS.sha256(self.wasm)}
        info = {"inputs": {"fixture": True}, "binary": self.entry, "gmp_library_sha256": "a" * 64,
                "commands": [{"argv": ["fixture"]}]}
        (self.directory / "yices2.wasm").write_bytes(self.wasm)
        proof = SOLVERS.encoded(info)
        (self.directory / "yices2-build.json").write_bytes(proof)
        self.manifest = {"format_version": 1, "inputs": {"fixture": True}, "assets": [self.entry,
                         {"path": "yices2-build.json", "size": len(proof), "sha256": SOLVERS.sha256(proof)}]}
        self.write_manifest()

    def write_manifest(self):
        (self.directory / "manifest.json").write_bytes(SOLVERS.encoded(self.manifest))

    def test_bundle_identity(self):
        self.assertEqual(SOLVERS.read_bundle(ROOT, self.directory), self.manifest)

    def test_manifest_format_source_identity_and_asset_inventory_fail_closed(self):
        original = self.manifest.copy()
        for change in ({"format_version": True}, {"inputs": {}}, {"assets": []}, {"assets": [self.entry, self.entry]}):
            with self.subTest(change=change):
                self.manifest = {**original, **change}
                self.write_manifest()
                with self.assertRaises(ValueError):
                    SOLVERS.read_bundle(ROOT, self.directory)

    def test_asset_paths_sizes_hashes_and_types_fail_closed(self):
        for change in ({"path": "../escape"}, {"size": True}, {"size": 0}, {"size": SOLVERS.LIMIT},
                       {"sha256": "invalid"}, {"encoding": "zstd"}):
            with self.subTest(change=change):
                self.manifest["assets"][0] = {**self.entry, **change}
                self.write_manifest()
                with self.assertRaises(ValueError):
                    SOLVERS.read_bundle(ROOT, self.directory)

    def test_modified_missing_and_linked_binary_fail_closed(self):
        file = self.directory / "yices2.wasm"
        file.write_bytes(self.wasm[:-1])
        with self.assertRaises(ValueError):
            SOLVERS.read_bundle(ROOT, self.directory)
        file.unlink()
        with self.assertRaises(ValueError):
            SOLVERS.read_bundle(ROOT, self.directory)
        file.symlink_to(ROOT / "web/index.html")
        with self.assertRaises(ValueError):
            SOLVERS.read_bundle(ROOT, self.directory)
