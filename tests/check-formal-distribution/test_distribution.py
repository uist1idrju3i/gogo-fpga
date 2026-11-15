import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("formal_distribution", ROOT / "scripts/formal-distribution.py")
DIST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DIST)


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
        result = DIST.audit(self.directory)
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
