import copy
import csv
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("library_assets", ROOT / "scripts/build-library-assets.py")
library_assets = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(library_assets)


class LibraryAssetsTests(unittest.TestCase):
    def test_e2e_fetches_pinned_library_sources_before_web_server(self):
        workflow = (ROOT / ".github/workflows/build.yml").read_text(encoding="utf-8")
        e2e = workflow.split("\n  e2e:\n", 1)[1]
        checkout = e2e.index("- uses: actions/checkout@")
        sources = e2e.index("git submodule update --init --depth 1 -- vendor/zstd third_party/")
        nested = e2e.index("git -C third_party/vexriscv submodule update --init --depth 1 -- pythondata_cpu_vexriscv/verilog/ext/VexRiscv")
        browser = e2e.index("- name: Playwright E2E")
        self.assertLess(checkout, sources)
        self.assertLess(sources, nested)
        self.assertLess(nested, browser)

    def test_cpu_board_availability_matches_all_formal_main_rows(self):
        catalog = json.loads((ROOT / "libraries/catalog.json").read_text())
        with (ROOT / "docs/experiments/S14-production-cpu.csv").open(newline="") as stream:
            rows = list(csv.DictReader(stream))
        main = [row for row in rows if row["run_id"].startswith("main-")]
        self.assertEqual(len(main), 280)
        cases = {}
        for row in main:
            cases.setdefault((row["library"], row["board"]), []).append(row)
        candidates = {"serv", "picorv32", "neorv32", "hazard3", "vexriscv", "darkriscv", "femtorv"}
        boards = {"tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"}
        self.assertEqual(set(cases), {(candidate, board) for candidate in candidates for board in boards})
        mapping = {"passed": "confirmed", "capacity-exceeded": "capacity-exceeded", "frontend-unsupported": "frontend-unsupported"}
        for entry in catalog["entries"]:
            if entry["id"] not in candidates:
                continue
            self.assertEqual(len(entry["components"]), 1)
            actual = entry["components"][0]["boards"]
            self.assertEqual(set(actual), boards)
            for board in boards:
                with self.subTest(candidate=entry["id"], board=board):
                    measured = cases[(entry["id"], board)]
                    self.assertEqual(len(measured), 10)
                    self.assertEqual({row["variant"] for row in measured}, {"native", "wasi"})
                    self.assertEqual({row["repeat"] for row in measured}, {"1", "2", "3", "4", "5"})
                    statuses = {row["status"] for row in measured}
                    self.assertEqual(len(statuses), 1)
                    status = statuses.pop()
                    self.assertEqual({row["case_status"] for row in measured}, {status})
                    self.assertEqual(actual[board], mapping[status])
            self.assertEqual(entry["status"], "available" if "confirmed" in actual.values() else "frontend-unsupported")

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "third_party/probe"
        self.source.mkdir(parents=True)
        self.git(self.root, "init", "-q")
        self.git(self.source, "init", "-q")
        (self.source / "LICENSE").write_text("Test license\n", encoding="utf-8")
        (self.source / "probe.v").write_text("module probe; endmodule\n", encoding="utf-8")
        self.git(self.source, "add", ".")
        self.git(self.source, "commit", "-q", "-m", "検証用の固定ソース")
        self.revision = self.git(self.source, "rev-parse", "HEAD").strip()
        self.git(self.root, "update-index", "--add", "--cacheinfo", f"160000,{self.revision},third_party/probe")
        (self.root / ".gitmodules").write_text(
            '[submodule "third_party/probe"]\n'
            "path = third_party/probe\n"
            "url = https://example.invalid/probe.git\n"
            "shallow = true\n"
            "branch = main\n",
            encoding="utf-8",
        )
        self.component = {
            "id": "probe", "label": "検証用回路", "sources": [{"path": "probe.v", "language": "verilog"}],
            "data": [], "dependencies": [], "includeDirectories": [], "defines": {},
            "boards": {"tangnano1k": "unverified"},
        }
        self.entry = {
            "id": "probe", "label": "検証用ライブラリー", "kind": "library", "language": "verilog",
            "submodule": "third_party/probe", "license": {"expression": "LicenseRef-Test", "files": ["LICENSE"]},
            "deprecated": False, "status": "unverified", "reason": "未検証です。", "components": [self.component],
        }
        self.catalog = {"formatVersion": 1, "entries": [self.entry]}

    @staticmethod
    def git(root, *args):
        env = os.environ | {
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }
        return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.PIPE, env=env)

    def build(self):
        return library_assets.build_catalog(self.root, self.catalog, self.root / "assets")

    def nested_license(self):
        nested = self.source / "deps/core"
        nested.mkdir(parents=True)
        self.git(nested, "init", "-q")
        (nested / "LICENSE").write_text("Copyright test upstream contributors\n", encoding="utf-8")
        self.git(nested, "add", "LICENSE")
        self.git(nested, "commit", "-q", "-m", "検証用の生成元ライセンス")
        revision = self.git(nested, "rev-parse", "HEAD").strip()
        (self.source / ".gitmodules").write_text(
            '[submodule "deps/core"]\npath = deps/core\nurl = https://example.invalid/core.git\n',
            encoding="utf-8",
        )
        self.git(self.source, "add", ".gitmodules")
        self.git(self.source, "update-index", "--add", "--cacheinfo", f"160000,{revision},deps/core")
        self.git(self.source, "commit", "-q", "-m", "検証用の入れ子の固定版")
        self.revision = self.git(self.source, "rev-parse", "HEAD").strip()
        self.git(self.root, "update-index", "--cacheinfo", f"160000,{self.revision},third_party/probe")
        self.entry["license"]["files"].append("deps/core/LICENSE")
        return nested, revision

    def test_approved_catalog_covers_all_22_candidates_without_duplicate_pins(self):
        catalog = json.loads((ROOT / "libraries/catalog.json").read_text(encoding="utf-8"))
        entries = library_assets.validate_catalog(catalog)
        self.assertEqual(len(entries), 22)
        self.assertEqual(sum(entry["status"] == "unsupported" for entry in entries), 7)
        self.assertEqual({entry["id"] for entry in entries if entry["deprecated"]}, {
            "verilog-axis", "verilog-uart", "verilog-axi", "verilog-ethernet",
        })
        self.assertEqual(set(library_assets.submodules(ROOT)), {entry["submodule"] for entry in entries})
        for entry in entries:
            self.assertNotIn("revision", entry)
            self.assertNotIn("url", entry)

    def test_assets_keep_original_bytes_paths_and_pinned_provenance(self):
        manifest = self.build()
        entry = manifest["entries"][0]
        self.assertEqual(entry["source"], {"url": "https://example.invalid/probe.git", "revision": self.revision})
        assets = entry["license"]["files"] + entry["components"][0]["sources"]
        for asset in assets:
            expected = (self.source / asset["path"]).read_bytes()
            self.assertEqual((self.root / "assets" / asset["asset"]).read_bytes(), expected)
            self.assertEqual(asset["size"], len(expected))
            self.assertEqual(asset["sha256"], hashlib.sha256(expected).hexdigest())
        self.assertEqual(json.loads((self.root / "assets/catalog.json").read_text()), manifest)

    def test_checkout_edits_cannot_replace_pinned_upstream_objects(self):
        (self.source / "probe.v").write_text("modified source\n", encoding="utf-8")
        self.build()
        self.assertEqual((self.root / "assets/probe/probe.v").read_text(), "module probe; endmodule\n")

    def test_nested_license_keeps_pinned_bytes_and_provenance(self):
        nested, revision = self.nested_license()
        (nested / "LICENSE").write_text("modified checkout\n")
        manifest = self.build()
        record = manifest["entries"][0]["license"]["files"][1]
        self.assertEqual(record["provenance"], [{
            "path": "deps/core", "url": "https://example.invalid/core.git", "revision": revision,
        }])
        self.assertEqual((self.root / "assets" / record["asset"]).read_text(), "Copyright test upstream contributors\n")

    def test_nested_license_rejects_missing_or_wrong_checkout_and_symlinks(self):
        nested, _ = self.nested_license()
        saved = nested.with_name("saved-core")
        nested.rename(saved)
        with self.assertRaisesRegex(ValueError, "Missing initialized nested"):
            self.build()
        nested.symlink_to(saved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "submodule symlink"):
            self.build()
        nested.unlink()
        saved.rename(nested)
        self.git(nested, "commit", "--allow-empty", "-q", "-m", "検証用の別の生成元")
        with self.assertRaisesRegex(ValueError, "nested checkout differs"):
            self.build()
        self.assertFalse((self.root / "assets").exists())

    def test_nested_license_ignores_unpinned_worktree_url(self):
        self.nested_license()
        config = self.source / ".gitmodules"
        config.write_text('[submodule "deps/core"]\npath = deps/core\nurl = file:///wrong\n')
        self.assertEqual(self.build()["entries"][0]["license"]["files"][1]["provenance"][0]["url"],
                         "https://example.invalid/core.git")

    def test_parameter_metadata_is_preserved_and_invalid_shapes_are_rejected(self):
        self.component["parameters"] = {"WIDTH": "8"}
        self.assertEqual(self.build()["entries"][0]["components"][0]["parameters"], {"WIDTH": "8"})
        for parameters in (None, [], {"WIDTH": 8}, {"bad name": "8"}, {"WIDTH": "8\n"}):
            with self.subTest(parameters=parameters), self.assertRaisesRegex(ValueError, "parameter metadata"):
                self.component["parameters"] = parameters
                library_assets.validate_catalog(self.catalog)

    def test_builds_are_reproducible_and_do_not_overwrite_existing_evidence(self):
        first = self.build()
        second = library_assets.build_catalog(self.root, self.catalog, self.root / "second")
        self.assertEqual(first, second)
        self.assertEqual((self.root / "assets/catalog.json").read_bytes(), (self.root / "second/catalog.json").read_bytes())
        with self.assertRaisesRegex(ValueError, "overwrite"):
            self.build()

    def test_revision_mismatch_is_rejected(self):
        self.git(self.source, "commit", "--allow-empty", "-q", "-m", "検証用の別の固定版")
        with self.assertRaisesRegex(ValueError, "differs"):
            self.build()
        self.assertFalse((self.root / "assets").exists())

    def test_missing_source_and_license_fail_before_publishing(self):
        for kind in ("source", "license"):
            with self.subTest(kind=kind):
                catalog = copy.deepcopy(self.catalog)
                if kind == "source":
                    catalog["entries"][0]["components"][0]["sources"][0]["path"] = "missing.v"
                else:
                    catalog["entries"][0]["license"]["files"] = ["missing.txt"]
                with self.assertRaisesRegex(ValueError, "Missing pinned source"):
                    library_assets.build_catalog(self.root, catalog, self.root / "assets")
                self.assertFalse((self.root / "assets").exists())

    def test_symlinks_are_not_followed(self):
        (self.source / "linked.v").symlink_to("probe.v")
        self.git(self.source, "add", "linked.v")
        self.git(self.source, "commit", "-q", "-m", "検証用のリンク")
        revision = self.git(self.source, "rev-parse", "HEAD").strip()
        with self.assertRaisesRegex(ValueError, "Not a regular pinned file"):
            library_assets.pinned_file(self.source, revision, "linked.v")

    def test_path_traversal_is_rejected(self):
        for path in ("../LICENSE", "/LICENSE", "a//b.v", "a/./b.v", "a/../b.v", "a\\b.v"):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Invalid library path"):
                library_assets.relative_path(path)

    def test_catalog_cannot_omit_a_registered_submodule(self):
        with self.assertRaisesRegex(ValueError, "do not match"):
            library_assets.build_catalog(self.root, {"formatVersion": 1, "entries": []}, self.root / "assets")

    def test_missing_or_unknown_metadata_fails_closed(self):
        for field in ("license", "reason", "source"):
            with self.subTest(field=field):
                catalog = copy.deepcopy(self.catalog)
                if field == "source":
                    catalog["entries"][0][field] = {"revision": "a" * 40}
                else:
                    del catalog["entries"][0][field]
                with self.assertRaises(ValueError):
                    library_assets.validate_catalog(catalog)

    def test_duplicate_ids_and_unsupported_components_are_rejected(self):
        self.catalog["entries"].append(copy.deepcopy(self.entry))
        with self.assertRaisesRegex(ValueError, "duplicate library id"):
            library_assets.validate_catalog(self.catalog)
        self.catalog["entries"].pop()
        self.entry["status"] = "unsupported"
        with self.assertRaisesRegex(ValueError, "cannot expose components"):
            library_assets.validate_catalog(self.catalog)

    def test_vhdl_sources_need_named_libraries(self):
        self.component["sources"] = [{"path": "probe.vhd", "language": "vhdl"}]
        with self.assertRaisesRegex(ValueError, "VHDL library name"):
            library_assets.validate_catalog(self.catalog)
        self.component["sources"][0]["library"] = "work"
        library_assets.validate_catalog(self.catalog)

    def test_available_status_requires_a_confirmed_board(self):
        self.entry["status"] = "available"
        with self.assertRaisesRegex(ValueError, "no confirmed board"):
            library_assets.validate_catalog(self.catalog)
        self.component["boards"]["tangnano1k"] = "confirmed"
        library_assets.validate_catalog(self.catalog)

    def test_frontend_unsupported_requires_component_evidence_and_never_confirmed_boards(self):
        self.entry["status"] = "frontend-unsupported"
        self.component["boards"]["tangnano1k"] = "frontend-unsupported"
        library_assets.validate_catalog(self.catalog)
        for state in ("confirmed", "unverified", "capacity-exceeded"):
            with self.subTest(state=state):
                self.component["boards"]["tangnano1k"] = state
                with self.assertRaisesRegex(ValueError, "must retain only unsupported boards"):
                    library_assets.validate_catalog(self.catalog)
        self.entry["components"] = []
        with self.assertRaisesRegex(ValueError, "must retain only unsupported boards"):
            library_assets.validate_catalog(self.catalog)

    def test_missing_and_cyclic_dependencies_are_rejected(self):
        self.component["dependencies"] = ["missing/probe"]
        with self.assertRaisesRegex(ValueError, "Unknown component"):
            library_assets.validate_catalog(self.catalog)
        self.component["dependencies"] = ["probe/probe"]
        with self.assertRaisesRegex(ValueError, "Cyclic component"):
            library_assets.validate_catalog(self.catalog)

    def test_release_sources_rebuild_without_git_and_reject_modified_files(self):
        self.nested_license()
        manifest = self.build()
        archive = self.root / "archive"
        (archive / "libraries").mkdir(parents=True)
        shutil.copyfile(self.root / ".gitmodules", archive / ".gitmodules")
        shutil.copytree(self.source, archive / "third_party/probe", ignore=shutil.ignore_patterns(".git"))
        (archive / "third_party/probe/deps/core/LICENSE").unlink()
        library_assets.copy_nested_assets(self.root, manifest, archive)
        (archive / "third_party/probe/.gitcommit").write_text(self.revision + "\n")
        (archive / "libraries/source-manifest.json").write_text(json.dumps(manifest))
        with patch.object(library_assets, "git", side_effect=AssertionError("Git is unavailable")):
            rebuilt = library_assets.build_catalog(archive, self.catalog, self.root / "rebuilt")
        self.assertEqual(rebuilt, manifest)
        (archive / "third_party/probe/probe.v").write_text("different\n")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            library_assets.build_catalog(archive, self.catalog, self.root / "corrupt")
        self.assertFalse((self.root / "corrupt").exists())

    def test_nested_archive_export_rejects_provenance_and_hash_corruption(self):
        self.nested_license()
        manifest = self.build()
        output = self.root / "archive"
        output.mkdir()
        for key, value in (("sha256", "0" * 64), ("provenance", []), ("size", 1)):
            changed = copy.deepcopy(manifest)
            asset = changed["entries"][0]["license"]["files"][1]
            asset[key] = value if key != "provenance" else [{"path": "deps/core", "url": "https://wrong.invalid/", "revision": "1" * 40}]
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "provenance or hash mismatch"):
                library_assets.copy_nested_assets(self.root, changed, output)
            self.assertEqual(list(output.iterdir()), [])

    def test_nested_archive_rejects_invalid_provenance_shapes(self):
        _, revision = self.nested_license()
        entry = self.build()["entries"][0]
        origin = {"path": "deps/core", "url": "https://example.invalid/core.git", "revision": revision}
        invalid = [None, {}, [None], [dict(origin, path="../core")], [dict(origin, path="wrong")],
                   [dict(origin, url=None)], [dict(origin, url="file:///core")],
                   [dict(origin, revision=None)], [dict(origin, revision="main")], [origin, origin]]
        for provenance in invalid:
            changed = copy.deepcopy(entry)
            changed["license"]["files"][1]["provenance"] = provenance
            with self.subTest(provenance=provenance), self.assertRaises(ValueError):
                library_assets.archive_file(self.root, "third_party/probe", changed, "deps/core/LICENSE")


if __name__ == "__main__":
    unittest.main()
