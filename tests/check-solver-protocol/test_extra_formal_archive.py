import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/package-extra-formal.py"
SPEC = importlib.util.spec_from_file_location("campaign_archive", SCRIPT)
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)


class ExtraFormalArchiveTest(unittest.TestCase):
    def test_trace_campaign_requires_its_auditors_and_original_writer(self):
        sources = ARCHIVE.campaign_sources({"kind": "formal-trace-v1"})
        self.assertEqual(sources[0], "scripts/measure-formal-trace.py")
        self.assertIn("scripts/audit-formal-trace.py", sources)
        self.assertIn("vendor/yosys/backends/smt2/smtio.py", sources)
        self.assertEqual(ARCHIVE.campaign_sources({}), ["scripts/" + name for name in ARCHIVE.AUDITORS])
        with self.assertRaisesRegex(ValueError, "unknown campaign"):
            ARCHIVE.campaign_sources({"kind": "untrusted"})

    def test_staging_materializes_only_hash_verified_native_launchers(self):
        binary = self.base.parent / (self.base.name + "-native")
        binary.write_bytes(b"native executable")
        self.addCleanup(binary.unlink)
        alias = self.campaign / "solver-bin/solver"
        alias.parent.mkdir()
        alias.symlink_to(binary)
        metadata = {"solverCommands": {"solver": {"path": str(alias), "sha256": ARCHIVE.digest(binary.read_bytes())}}}
        (self.campaign / "metadata.json").write_text(json.dumps(metadata))
        output = self.base / "staged"
        report = ARCHIVE.stage([self.campaign], output)
        restored = output / alias.relative_to(self.base)
        self.assertFalse(restored.is_symlink())
        self.assertEqual(restored.read_bytes(), binary.read_bytes())
        self.assertEqual(len(report["materializedLaunchers"]), 1)
        self.assertTrue(alias.is_symlink())
        with patch("os.getcwd", return_value=str(self.base)):
            self.assertEqual(len(ARCHIVE.collect([str(output.relative_to(self.base))])), report["files"] + 1)
        with self.assertRaises(ValueError):
            ARCHIVE.stage([self.campaign], output)
        binary.write_bytes(b"changed native")
        with self.assertRaisesRegex(ValueError, "unverified launcher"):
            ARCHIVE.stage([self.campaign], self.base / "changed")
        with self.assertRaises(ValueError):
            ARCHIVE.stage([self.campaign], self.campaign / "nested")
        linked = self.base / "linked"
        linked.symlink_to(self.campaign.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            ARCHIVE.stage([linked / self.campaign.name], self.base / "indirect")
        with self.assertRaises(ValueError):
            ARCHIVE.stage([self.campaign], linked / "output")

    def test_staging_materializes_mutated_clone_launchers_only_against_the_original(self):
        binary = self.base / "clone-native"
        binary.write_bytes(b"native executable")
        original = self.campaign / "solver-bin/solver"
        original.parent.mkdir()
        original.symlink_to(binary)
        metadata = {"solverCommands": {"solver": {"path": str(original), "sha256": ARCHIVE.digest(binary.read_bytes())}}}
        (self.campaign / "metadata.json").write_text(json.dumps(metadata))
        clone = self.campaign / "mutated-evidence"
        clone.mkdir()
        (clone / "metadata.json").write_text(json.dumps(metadata))
        clone_alias = clone / "solver-bin/solver"
        clone_alias.parent.mkdir()
        clone_alias.symlink_to(binary)

        output = self.base / "clone-staged"
        report = ARCHIVE.stage([self.campaign], output)
        restored = output / clone_alias.relative_to(self.base)
        self.assertFalse(restored.is_symlink())
        self.assertEqual(restored.read_bytes(), binary.read_bytes())
        self.assertEqual(report["materializedCloneLaunchers"], [{
            "path": clone_alias.relative_to(self.base).as_posix(),
            "launcher": original.relative_to(self.base).as_posix(),
            "sha256": ARCHIVE.digest(binary.read_bytes()),
        }])
        self.assertEqual(len(report["materializedLaunchers"]), 1)

        def prepare_case(label, clone_name="mutated-evidence", relative_targets=False):
            campaign = self.base / "build/S15" / label
            campaign.mkdir(parents=True)
            original = campaign / "solver-bin/solver"
            original.parent.mkdir()
            clone = campaign / clone_name
            clone.mkdir()
            clone_alias = clone / "solver-bin/solver"
            clone_alias.parent.mkdir()
            if relative_targets:
                binary = campaign / "native"
                clone_binary = clone / "native"
                link_text = "../native"
                binary.write_bytes(b"native executable")
                clone_binary.write_bytes(b"native executable")
                original.symlink_to(link_text)
                clone_alias.symlink_to(link_text)
            else:
                binary = self.base / (label + "-native")
                binary.write_bytes(b"native executable")
                original.symlink_to(binary)
                clone_alias.symlink_to(binary)
            metadata = {"solverCommands": {"solver": {
                "path": str(original), "sha256": ARCHIVE.digest(binary.read_bytes())}}}
            (campaign / "metadata.json").write_text(json.dumps(metadata))
            (clone / "metadata.json").write_text(json.dumps(metadata))
            return campaign, original, clone_alias, binary, clone_binary if relative_targets else binary

        campaign, original, clone_alias, binary, clone_binary = prepare_case("clone-wrong-link")
        other = self.base / "clone-wrong-link-other"
        other.write_bytes(binary.read_bytes())
        clone_alias.unlink()
        clone_alias.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "unverified launcher"):
            ARCHIVE.stage([campaign], self.base / "clone-wrong-link-staged")

        campaign, original, clone_alias, _, _ = prepare_case("clone-missing-original")
        original.unlink()
        with self.assertRaisesRegex(ValueError, "unverified launcher"):
            ARCHIVE.stage([campaign], self.base / "clone-missing-original-staged")

        campaign, _, _, _, _ = prepare_case("clone-wrong-directory", clone_name="mutated")
        with self.assertRaisesRegex(ValueError, "unverified launcher"):
            ARCHIVE.stage([campaign], self.base / "clone-wrong-directory-staged")

        campaign, _, _, _, clone_binary = prepare_case("clone-hash-mismatch", relative_targets=True)
        clone_binary.write_bytes(b"mutated executable")
        with self.assertRaisesRegex(ValueError, "unverified launcher"):
            ARCHIVE.stage([campaign], self.base / "clone-hash-mismatch-staged")

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.campaign = self.base / "build/S15/formal"
        self.campaign.mkdir(parents=True)
        self.audit = self.campaign / "snapshots/scripts"
        self.audit.mkdir(parents=True)
        self.base.joinpath("scripts").mkdir()
        for name in ("measure-extra-formal.py", "audit-formal-python.py", "audit-formal-sby.py", "audit-formal-controls.py",
                     "sby-artifact-audit.py", "formal-solver-audit.py"):
            (self.audit / name).write_bytes(b"trusted " + name.encode())
            (self.base / "scripts" / name).write_bytes((self.audit / name).read_bytes())
        (self.campaign / "plan.json").write_text(json.dumps({"commit": "1" * 40}))
        (self.campaign / "raw.csv").write_bytes(b"series,status\naa,pass\n")
        (self.campaign / "raw-copy.csv").write_bytes(b"series,status\naa,pass\n")
        self.extra = self.base / "build/S15/failed.log"
        self.extra.write_bytes(b"rejected trial")
        self.original_root = ARCHIVE.ROOT
        ARCHIVE.ROOT = self.base
        self.addCleanup(setattr, ARCHIVE, "ROOT", self.original_root)
        self.audit_mock = patch.object(ARCHIVE, "audited_campaign", return_value={"status": "pass", "commit": "1" * 40})
        self.audit_mock.start()
        self.addCleanup(self.audit_mock.stop)
        self.git = patch.object(ARCHIVE.subprocess, "check_output", side_effect=["2" * 40, ""])
        self.git.start()
        self.addCleanup(self.git.stop)
        self.zip = self.base / "evidence.zip"

    def test_deduplicates_validates_restores_and_reaudits(self):
        reported = ARCHIVE.package(self.campaign, self.zip, [self.extra])
        self.assertGreater(reported["files"], reported["objects"])
        self.assertEqual(ARCHIVE.validate(self.zip)["extraPaths"], ["build/S15/failed.log"])
        with zipfile.ZipFile(self.zip) as archive:
            self.assertEqual(len(archive.namelist()), reported["objects"] + 1)
        summary = ARCHIVE.restore(self.zip, self.base / "restored")
        self.assertEqual(summary["status"], "pass")
        self.assertEqual((self.base / "restored/build/S15/formal/raw.csv").read_bytes(), b"series,status\naa,pass\n")
        self.assertEqual((self.base / "restored/build/S15/failed.log").read_bytes(), b"rejected trial")
        with self.assertRaises(FileExistsError):
            ARCHIVE.restore(self.zip, self.base / "restored")

    def test_rejects_hash_extra_missing_and_path_traversal(self):
        ARCHIVE.package(self.campaign, self.zip)
        with zipfile.ZipFile(self.zip) as original:
            objects = {name: original.read(name) for name in original.namelist()}
        for label, change in [
            ("hash", lambda manifest, files: files.__setitem__(next(name for name in files if name.startswith("objects/")), b"changed")),
            ("missing", lambda manifest, files: files.pop(next(name for name in files if name.startswith("objects/")))),
            ("extra", lambda manifest, files: files.__setitem__("unlisted.txt", b"x")),
            ("path", lambda manifest, files: manifest["files"][0].__setitem__("path", "../../elsewhere")),
            ("audit", lambda manifest, files: manifest["files"][0].__setitem__("sha256", "f" * 64)),
        ]:
            altered = self.base / (label + ".zip")
            contents = objects.copy()
            manifest = json.loads(contents["manifest.json"])
            change(manifest, contents)
            contents["manifest.json"] = json.dumps(manifest).encode()
            with zipfile.ZipFile(altered, "x") as archive:
                for name, data in contents.items():
                    archive.writestr(name, data)
            with self.subTest(label=label), self.assertRaises(ValueError):
                ARCHIVE.validate(altered)

    def test_rejects_absolute_symlink_and_malicious_manifest(self):
        with tempfile.NamedTemporaryFile() as outside:
            (self.campaign / "external").symlink_to(outside.name)
            with self.assertRaises(ValueError):
                ARCHIVE.package(self.campaign, self.zip)
        self.assertEqual(ARCHIVE.safe_path("build/S15/foo").as_posix(), "build/S15/foo")
        for name in ["../x", "/absolute", "./ambiguous", "x//y", "x\\y", "x/../y", "C:/absolute", "x/__pycache__/code.pyc", "x/code.pyc", "x/code.pyo"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                ARCHIVE.safe_path(name)
        for raw in [b'{"format":1,"format":1}', b'{"format":NaN}', b'{"format":Infinity}']:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                ARCHIVE.strict_json(raw)

    def test_manifest_size_is_checked_before_parsing(self):
        with zipfile.ZipFile(self.zip, "x") as archive:
            archive.writestr("manifest.json", b" " * 33)
        with patch.object(ARCHIVE, "MAX_MANIFEST", 32), self.assertRaisesRegex(ValueError, "oversized archive manifest"):
            ARCHIVE.validate(self.zip)

    def test_execution_checks_trusted_source_and_ignores_local_imports_and_bytecode(self):
        self.audit_mock.stop()
        runner = self.audit / "measure-extra-formal.py"
        raw = b'import json\nprint(json.dumps({"status":"pass", "commit":"' + b"1" * 40 + b'"}))\n'
        runner.write_bytes(raw)
        (self.base / "scripts/measure-extra-formal.py").write_bytes(raw)
        (self.audit / "json.py").write_text('raise RuntimeError("untrusted local import")\n')
        cache = self.audit / "__pycache__"
        cache.mkdir()
        (cache / "json.cpython-312.pyc").write_bytes(b"untrusted cached bytecode")
        self.assertEqual(ARCHIVE.audited_campaign(self.campaign)["status"], "pass")
        runner.write_bytes(raw + b"\n")
        with patch.object(ARCHIVE.subprocess, "run") as process, self.assertRaisesRegex(ValueError, "before execution"):
            ARCHIVE.audited_campaign(self.campaign)
        process.assert_not_called()


if __name__ == "__main__":
    unittest.main()
