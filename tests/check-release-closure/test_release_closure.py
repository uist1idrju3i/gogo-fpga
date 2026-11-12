import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
import warnings
import zipfile


SCRIPT = Path(os.environ.get("RELEASE_CLOSURE_SCRIPT", Path(__file__).resolve().parents[2] / "scripts/audit-release-closure.py"))
SPEC = importlib.util.spec_from_file_location("release_closure", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class ReleaseClosureTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="toolchain-release-closure-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "root"
        self.source = self.base / "source"
        self.generated = self.base / "generated"
        self.version = "vtest"
        self.prefix = f"toolchain-web-{self.version}/"
        self.root.mkdir()
        self.source.mkdir()
        self.pin = "a" * 40
        for name in ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
            self.write(self.root / name, f"Original {name}\n".encode())
            shutil.copyfile(self.root / name, self.source / name)
        self.write(self.root / "code.txt", b"Tracked source\n")
        shutil.copyfile(self.root / "code.txt", self.source / "code.txt")
        env = {**os.environ, "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull,
               "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
               "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid"}

        def git(*args):
            return subprocess.check_output(["git", "-C", str(self.root), *args], env=env, stderr=subprocess.PIPE).decode().strip()

        git("init", "--quiet")
        git("add", "README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "code.txt")
        git("update-index", "--add", "--cacheinfo", f"160000,{self.pin},third_party/sample")
        git("commit", "--quiet", "-m", "fixture")
        self.revision = git("rev-parse", "HEAD")
        payloads = {"sample/source.v": b"module sample; endmodule\n", "sample/LICENSE": b"MIT\n"}
        descriptors = {name: {"asset": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                       for name, data in payloads.items()}
        catalog = {"entries": [{"id": "sample", "submodule": "third_party/sample",
                               "source": {"revision": self.pin},
                               "license": {"files": [descriptors["sample/LICENSE"]]},
                               "files": [descriptors["sample/source.v"]]}]}
        catalog_bytes = json.dumps(catalog).encode()
        for location in [self.root / "dist/libraries", self.source / "dist/libraries", self.generated]:
            self.write(location / "catalog.json", catalog_bytes)
            for name, content in payloads.items():
                self.write(location / name, content)
        self.write(self.source / "libraries/source-manifest.json", catalog_bytes)
        self.write(self.source / "third_party/sample/.gitcommit", self.pin.encode())
        self.write(self.source / "RELEASE-SOURCE.json", json.dumps({"commit": self.revision, "version": self.version}).encode())
        self.write(self.source / "ordinary.txt", b"Source file\n")
        self.write(self.root / "dist/index.html", b"<title>Fixture</title>\n")
        self.write(self.root / "licenses/root.txt", b"Root license\n")
        self.write(self.root / "dist/surfer/licenses/surfer.txt", b"Surfer license\n")
        for folder in ["synth", "pack", "iverilog", "surfer"]:
            self.write(self.root / "dist" / folder / "asset.bin", folder.encode())
        (self.root / "release").mkdir()
        self.web_zip = self.root / f"release/toolchain-web-{self.version}.zip"
        with zipfile.ZipFile(self.web_zip, "w") as archive:
            for file in (self.root / "dist").rglob("*"):
                if file.is_file():
                    archive.write(file, self.prefix + file.relative_to(self.root / "dist").as_posix())
            for file in (self.root / "licenses").rglob("*"):
                archive.write(file, self.prefix + file.relative_to(self.root).as_posix())
            for name in ["README.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]:
                archive.write(self.root / name, self.prefix + name)
        self.source_tar = self.root / f"release/toolchain-source-{self.version}.tar.gz"
        with tarfile.open(self.source_tar, "w:gz") as archive:
            archive.add(self.source, arcname=f"toolchain-source-{self.version}")

    @staticmethod
    def write(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def audit(self, **kwargs):
        return AUDIT.audit(self.root, self.source, self.generated,
                           kwargs.get("version", self.version), kwargs.get("revision", self.revision))

    def test_valid_git_free_closure(self):
        report = self.audit()
        self.assertEqual(report["revision"], self.revision)
        self.assertEqual(report["library_entries"], 1)
        self.assertEqual(report["unique_library_assets"], 2)
        self.assertIn("compilers were not rebuilt", report["cached_inputs"])

    def test_git_archive_fallback_checks_source_bytes(self):
        AUDIT.compare_git_archive(self.root, self.revision, self.source)
        (self.source / "code.txt").write_bytes(b"broken")
        with self.assertRaisesRegex(ValueError, "Source Git archive mismatch"):
            AUDIT.compare_git_archive(self.root, self.revision, self.source)

    def test_modified_assets_and_notices_are_rejected(self):
        cases = [(self.generated / "sample/source.v", "Regenerated library asset mismatch"),
                 (self.root / "dist/libraries/sample/source.v", "Library asset hash mismatch"),
                 (self.source / "NOTICE", "Source notice mismatch"),
                 (self.source / "code.txt", "Source snapshot mismatch"),
                 (self.source / "third_party/sample/.gitcommit", "Source gitlink mismatch"),
                 (self.generated / "catalog.json", "Catalog mismatch")]
        for file, reason in cases:
            with self.subTest(file=str(file.relative_to(self.base))):
                original = file.read_bytes()
                try:
                    file.write_bytes(original + b"broken")
                    with self.assertRaisesRegex(ValueError, reason):
                        self.audit()
                finally:
                    file.write_bytes(original)

    def test_missing_tool_directory_is_rejected(self):
        shutil.rmtree(self.root / "dist/synth")
        with self.assertRaisesRegex(ValueError, "Missing tool distribution"):
            self.audit()

    def test_all_source_and_web_bytes_are_checked(self):
        for file, reason in [(self.source / "ordinary.txt", "Source archive content mismatch"),
                             (self.root / "dist/index.html", "Web distribution mismatch")]:
            with self.subTest(file=str(file.relative_to(self.base))):
                original = file.read_bytes()
                try:
                    file.write_bytes(original + b"broken")
                    with self.assertRaisesRegex(ValueError, reason):
                        self.audit()
                finally:
                    file.write_bytes(original)

    def test_duplicate_web_zip_member_is_rejected(self):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.web_zip, "a") as archive:
                archive.writestr(self.prefix + "libraries/catalog.json", b"duplicate")
        with self.assertRaisesRegex(ValueError, "Duplicate Web ZIP member"):
            self.audit()

    def test_source_escape_and_git_metadata_are_rejected(self):
        for name, link in [(f"toolchain-source-{self.version}/.git/config", None),
                           (f"toolchain-source-{self.version}/escape", "../../escape")]:
            with self.subTest(name=name):
                with tarfile.open(self.source_tar, "w:gz") as archive:
                    info = tarfile.TarInfo(name)
                    if link:
                        info.type = tarfile.SYMTYPE
                        info.linkname = link
                        archive.addfile(info)
                    else:
                        info.size = 1
                        archive.addfile(info, io.BytesIO(b"x"))
                with self.assertRaisesRegex(ValueError, "Unsafe archive|escapes archive root"):
                    self.audit()

    def test_unsafe_arguments_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "Invalid release version"):
            self.audit(version="../../escape")
        with self.assertRaisesRegex(ValueError, "full source revision"):
            self.audit(revision="HEAD")
        for path in ["", ".", "../x", "/x", "a/../x", "a\\x", "a/.git/config"]:
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Unsafe archive"):
                AUDIT.safe_path(path)

    def test_cli_refuses_to_overwrite_output(self):
        output = self.base / "audit.json"
        output.write_bytes(b"keep this evidence")
        result = subprocess.run([sys.executable, str(SCRIPT), "--root", str(self.root),
                                 "--source", str(self.source), "--generated-libraries", str(self.generated),
                                 "--version", self.version, "--revision", self.revision, "--output", str(output)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Refusing to overwrite", result.stderr)
        self.assertEqual(output.read_bytes(), b"keep this evidence")


if __name__ == "__main__":
    unittest.main()
