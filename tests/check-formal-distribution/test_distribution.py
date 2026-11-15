import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("formal_distribution", ROOT / "scripts/formal-distribution.py")
DIST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIST)
PYTHON_SPEC = importlib.util.spec_from_file_location("formal_python", ROOT / "scripts/build-formal-python.py")
PYTHON = importlib.util.module_from_spec(PYTHON_SPEC)
PYTHON_SPEC.loader.exec_module(PYTHON)


class FormalPythonArchiveTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.reference = self.directory / "reference"
        PYTHON.build(ROOT, self.reference)
        self.manifest = json.loads((self.reference / "manifest.json").read_text())
        self.archive = self.directory / "archive"
        for origin in self.manifest["origins"].values():
            name, source = origin["submodule"], origin["source"]
            target = self.archive / "vendor" / name / source
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(PYTHON.git(ROOT / "vendor" / name, "show", f"{self.manifest['pins'][name]}:{source}"))
        shutil.copytree(ROOT / "patches", self.archive / "patches")
        (self.archive / "web").mkdir()
        for name in ("formal_process.py", "formal_trace.py"):
            shutil.copyfile(ROOT / "web" / name, self.archive / "web" / name)
        self.provenance = self.archive / "vendor/formal-python-sources.json"
        self.provenance.write_text(json.dumps(self.manifest))

    def build(self):
        with patch.object(PYTHON, "git", side_effect=AssertionError("Source archive must not use Git")):
            output = self.directory / "rebuilt"
            PYTHON.build(self.archive, output)
        return output

    def test_git_free_rebuild_is_byte_identical_to_pinned_git_objects(self):
        output = self.build()
        self.assertEqual({path.relative_to(output): path.read_bytes() for path in output.rglob("*") if path.is_file()},
                         {path.relative_to(self.reference): path.read_bytes() for path in self.reference.rglob("*") if path.is_file()})

    def test_missing_or_invalid_archive_provenance_fails_closed(self):
        self.provenance.unlink()
        with self.assertRaises(OSError):
            self.build()
        for change in ({"format_version": True}, {"pins": {}}, {"pins": {"yosys": "invalid"}},
                       {"origins": {}}, {"origins": {**self.manifest["origins"], "extra.py": {}}}):
            shutil.rmtree(self.directory / "rebuilt")
            self.provenance.write_text(json.dumps({**self.manifest, **change}))
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build()

    def test_modified_missing_or_linked_archive_sources_fail_closed(self):
        source = self.archive / "vendor/yosys/backends/smt2/smtio.py"
        original = source.read_bytes()
        source.write_bytes(original + b"\n# modified\n")
        with self.assertRaisesRegex(ValueError, "identity mismatch"):
            self.build()
        shutil.rmtree(self.directory / "rebuilt")
        source.unlink()
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            self.build()
        shutil.rmtree(self.directory / "rebuilt")
        outside = self.directory / "smtio.py"
        outside.write_bytes(original)
        source.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Linked"):
            self.build()


class FormalDistributionTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.synth = self.directory / "synth"
        self.synth.mkdir()
        shutil.copyfile(ROOT / "web/serve.py", self.directory / "serve.py")
        # The fixtures test transport and identity checks, not Yosys execution.
        self.assets = {"yosys.wasm": b"\x00asm\x01\x00\x00\x00", "yosys-share.tar": b"fixture share"}
        self.manifest = {"format_version": 1, "assets": []}
        for path, data in self.assets.items():
            (self.synth / path).write_bytes(data)
            self.manifest["assets"].append({"path": path, "size": len(data), "sha256": DIST.sha256(data)})
        self.write_manifest()
        DIST.stage_licenses(self.directory)
        self.python = self.directory / "formal/python"
        self.python.parent.mkdir()
        subprocess.run([sys.executable, str(ROOT / "scripts/build-formal-python.py"), "--out", str(self.python)],
                       capture_output=True, check=True)

    def write_manifest(self):
        (self.synth / "manifest.json").write_text(json.dumps(self.manifest))

    def test_real_http_checks_assets_headers_and_exact_original_licenses(self):
        def inventory():
            return {str(path.relative_to(self.directory)): DIST.sha256(path.read_bytes())
                    for path in self.directory.rglob("*") if path.is_file()}
        before = inventory()
        with patch.object(sys, "dont_write_bytecode", False):
            result = DIST.audit(self.directory)
        self.assertEqual(inventory(), before, "The HTTP audit must not mutate its Web root")
        self.assertEqual(len(result["sat_assets"]), 2)
        self.assertEqual(len(result["licenses_checked"]), len(DIST.LICENSES))
        self.assertGreater(len(result["python"]["assets"]), 0)
        self.assertEqual(result["solvers"], "not-audited")
        self.assertEqual(result["browser_execution"], "not-audited")

    def test_200_html_and_malformed_json_cannot_pass(self):
        for body in ("<!doctype html><html>app</html>", '{"assets":'):
            with self.subTest(body=body):
                (self.synth / "manifest.json").write_text(body)
                with self.assertRaises(ValueError):
                    DIST.audit(self.directory)

    def test_missing_file_and_truncated_or_changed_downloads_cannot_pass(self):
        wasm = self.synth / "yosys.wasm"
        for data in (b"", b"broken!!", None):
            with self.subTest(data=data):
                if data is None:
                    wasm.unlink()
                else:
                    wasm.write_bytes(data)
                with self.assertRaises((OSError, ValueError)):
                    DIST.audit(self.directory)

    def test_invalid_metadata_cannot_pass(self):
        self.manifest["format_version"] = True
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Invalid SAT manifest"):
            DIST.audit(self.directory)
        self.manifest["format_version"] = 1
        original = self.manifest["assets"][0].copy()
        for change in ({"path": "../escape"}, {"size": True}, {"size": DIST.LIMIT},
                       {"encoding": "gzip"}, {"encoding": None}, {"encoding": "zstd"}, {"sha256": "invalid"}):
            with self.subTest(change=change):
                self.manifest["assets"][0] = {**original, **change}
                self.write_manifest()
                with self.assertRaises(ValueError):
                    DIST.audit(self.directory)
        self.manifest["assets"] = [original, original]
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            DIST.audit(self.directory)

    def test_mime_type_and_isolation_headers_are_required(self):
        original = (self.directory / "serve.py").read_text()
        for changed in (original.replace('".wasm": "application/wasm",', '".json": "text/html",'),
                        original.replace('"Cross-Origin-Embedder-Policy", "require-corp"',
                                         '"Cross-Origin-Embedder-Policy", "unsafe-none"')):
            with self.subTest(changed=changed):
                (self.directory / "serve.py").write_text(changed)
                with self.assertRaises(ValueError):
                    DIST.audit(self.directory)

    def test_missing_and_changed_licenses_cannot_pass(self):
        license_file = self.directory / "licenses/yosys-COPYING"
        for data in (b"changed", None):
            if data is None:
                license_file.unlink()
            else:
                license_file.write_bytes(data)
            with self.assertRaises((ValueError, OSError)):
                DIST.audit(self.directory)

    def test_zstd_compressed_and_decoded_identity_are_independently_checked(self):
        entry = self.manifest["assets"][0]
        data = self.assets["yosys.wasm"]
        compressed = subprocess.run(["zstd", "-q", "-c"], input=data, capture_output=True, check=True).stdout
        (self.synth / "yosys.wasm.zst").write_bytes(compressed)
        entry.update(encoding="zstd", compressed_size=len(compressed), compressed_sha256=DIST.sha256(compressed))
        self.write_manifest()
        DIST.audit(self.directory)
        for change in ({"compressed_sha256": "a" * 64}, {"sha256": "b" * 64}):
            saved = entry.copy()
            entry.update(change)
            self.write_manifest()
            with self.assertRaises(ValueError):
                DIST.audit(self.directory)
            entry.clear()
            entry.update(saved)

    def test_python_html_modified_source_and_metadata_or_missing_license_cannot_pass(self):
        path = self.python / "manifest.json"
        original = path.read_bytes()
        manifest = json.loads(original)
        changed_pin = json.loads(original)
        changed_pin["pins"]["sby"] = "0" * 40
        for data in (b"<html>app</html>", b'{"assets":', json.dumps(changed_pin).encode()):
            path.write_bytes(data)
            with self.assertRaises(ValueError):
                DIST.audit(self.directory)
        path.write_bytes(original)
        source = self.python / manifest["assets"][0]["path"]
        original_source = source.read_bytes()
        source.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Python asset identity mismatch"):
            DIST.audit(self.directory)
        source.write_bytes(original_source)
        (self.python / "licenses/sby-COPYING").unlink()
        with self.assertRaises((OSError, ValueError)):
            DIST.audit(self.directory)


if __name__ == "__main__":
    unittest.main()
