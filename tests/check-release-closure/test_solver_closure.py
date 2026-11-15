"""Exercise the solver closure with real validators and small, uncompiled fixtures."""

import importlib.util
import os
from pathlib import Path
import runpy
import shutil
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("solver_release_closure", ROOT / "scripts/audit-release-closure.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
SOLVERS = runpy.run_path(str(ROOT / "scripts/build-formal-solvers.py"))


class SolverClosureTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name) / "root"
        self.source = Path(temporary.name) / "source"
        names = ["RESEARCH.md", ".github/scripts/check-pins.py"]
        names += ["scripts/" + name for name in ("build-formal-solvers.py", "build-solver-probe.py", "prepare-formal-sources.py")]
        names += ["patches/" + name for name in SOLVERS["PATCHES"]]
        names += ["licenses/gmp-" + name for name in ("COPYING", "COPYINGv2", "COPYINGv3", "COPYING.LESSERv3")]
        for name in names:
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, destination)
        checker = runpy.run_path(str(self.root / ".github/scripts/check-pins.py"))
        pin = checker["parse_formal_pins"]((self.root / "RESEARCH.md").read_text())["yices2"]
        upstream = self.root / "vendor/yices2"
        upstream.mkdir(parents=True)
        (upstream / "LICENSE.txt").write_bytes(b"Solver closure fixture license\n")
        (upstream / ".gitcommit").write_text(pin["commit"] + "\n")
        snapshot = {"format_version": 1, "pin": pin, "files": {
            "LICENSE.txt": {"sha256": SOLVERS["sha256"]((upstream / "LICENSE.txt").read_bytes())}}}
        (self.root / SOLVERS["SNAPSHOT"]).write_bytes(SOLVERS["encoded"](snapshot))
        shutil.copytree(self.root, self.source)
        fixture_env = patch.dict(os.environ, {"BUILD_ROOT": str(self.root / "build")})
        fixture_env.start()
        self.addCleanup(fixture_env.stop)
        self.bundle = self.root / "build/formal-solvers"
        self.bundle.mkdir(parents=True)
        # Valid empty WASM tests closure only; product tests execute the real solver.
        binary = b"\0asm\1\0\0\0"
        recipe = SOLVERS["inputs"](self.root)
        identity = {"path": "yices2.wasm", "size": len(binary), "sha256": SOLVERS["sha256"](binary)}
        proof = SOLVERS["encoded"]({"inputs": recipe, "binary": identity, "gmp_library_sha256": "a" * 64,
                                    "commands": [{"argv": ["fixture"]}]})
        (self.bundle / "yices2.wasm").write_bytes(binary)
        (self.bundle / "yices2-build.json").write_bytes(proof)
        (self.bundle / "manifest.json").write_bytes(SOLVERS["encoded"]({"format_version": 1, "inputs": recipe, "assets": [identity,
            {"path": "yices2-build.json", "size": len(proof), "sha256": SOLVERS["sha256"](proof)}]}))
        self.web = self.root / "public_html/formal/solvers"
        shutil.copytree(self.bundle, self.web)

    def test_matching_solver_source_recipe_and_web_pass(self):
        AUDIT.audit_solver_closure(self.root, self.source)

    def test_missing_and_wrong_archived_gitcommit_fail_closed(self):
        marker = self.source / "vendor/yices2/.gitcommit"
        marker.unlink()
        with self.assertRaises(OSError):
            AUDIT.audit_solver_closure(self.root, self.source)
        marker.write_text("0" * 40)
        with self.assertRaisesRegex(ValueError, "pin mismatch"):
            AUDIT.audit_solver_closure(self.root, self.source)

    def test_modified_archived_source_fails_closed(self):
        (self.source / "vendor/yices2/LICENSE.txt").write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            AUDIT.audit_solver_closure(self.root, self.source)

    def test_different_archived_build_inputs_fail_closed(self):
        (self.source / "patches" / SOLVERS["PATCHES"][0]).write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "Archived solver build inputs mismatch"):
            AUDIT.audit_solver_closure(self.root, self.source)

    def test_missing_and_modified_distribution_assets_fail_closed(self):
        for name in ("manifest.json", "yices2.wasm", "yices2-build.json"):
            file = self.web / name
            original = file.read_bytes()
            with self.subTest(name=name):
                file.unlink()
                with self.assertRaises(OSError):
                    AUDIT.audit_solver_closure(self.root, self.source)
                file.write_bytes(b"modified")
                with self.assertRaisesRegex(ValueError, "differs from pinned build"):
                    AUDIT.audit_solver_closure(self.root, self.source)
                file.write_bytes(original)

    def test_changed_cached_bundle_fails_closed(self):
        (self.bundle / "yices2.wasm").write_bytes(b"modified")
        with self.assertRaisesRegex(ValueError, "asset identity mismatch"):
            AUDIT.audit_solver_closure(self.root, self.source)
