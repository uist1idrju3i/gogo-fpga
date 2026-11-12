import copy
import hashlib
import importlib.util
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("publish_pages", ROOT / "scripts/publish-pages.py")
PAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAGES)
HEADERS = "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n"
SHA = "a" * 40
RUN_URL = "https://github.com/example/project/actions/runs/7"


def run_info(number=7):
    return {"id": number, "run_number": number, "event": "push", "head_branch": "main",
            "head_sha": SHA, "conclusion": "success", "status": "completed",
            "path": ".github/workflows/build.yml",
            "head_repository": {"full_name": "example/project"},
            "repository": {"full_name": "example/project"}}


def artifact(run):
    return {"id": 90, "name": f"gogo-fpga-web-{run['head_sha']}", "expired": False,
            "digest": "sha256:" + "b" * 64,
            "workflow_run": {"id": run["id"], "head_branch": "main", "head_sha": run["head_sha"]}}


class FakeAPI:
    repository = "example/project"

    def __init__(self):
        self.run = run_info()
        self.jobs = [{"name": name, "conclusion": "success"} for name in PAGES.REQUIRED_JOBS]
        self.artifacts = [artifact(self.run)]
        self.runs = [self.run]
        self.prs = []
        self.writes = []

    def request(self, path, method="GET", body=None):
        if method == "GET":
            return self.run
        self.writes.append((path, method, body))
        return {"number": 200, "html_url": "https://github.com/example/project/pull/200"}

    def items(self, path, key=None):
        if path.endswith("/jobs"):
            return iter(self.jobs)
        if path.endswith("/artifacts"):
            return iter(self.artifacts)
        if path.startswith("actions/workflows/"):
            return iter(self.runs)
        return iter(self.prs)


class PublishPagesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "public_html"
        self.source.mkdir()
        (self.source / "index.html").write_text("verified app", encoding="utf-8")
        (self.source / "_headers").write_text(HEADERS, encoding="utf-8")
        self.repo = self.root / "delivery"

    def test_orphan_bootstrap_identical_noop_changed_commit_and_candidate_reuse(self):
        first = PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        self.assertTrue(first["bootstrap_created"])
        self.assertTrue(first["new_commit"])
        base = first["base_commit"]
        self.assertEqual(PAGES.git(self.repo, "rev-list", "--parents", "-n", "1", base), base)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", base).splitlines(),
                         ["README.md", "public_html"])
        self.assertNotEqual(PAGES.git(self.repo, "show", f"{base}:public_html/index.html"), "verified app")
        self.assertEqual(PAGES.git(self.repo, "show", f"{first['commit']}:public_html/index.html"), "verified app")
        again = PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        self.assertEqual(again["status"], "existing")
        self.assertFalse(again["new_commit"])
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", first["commit"])
        identical = PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL)
        self.assertEqual(identical["status"], "unchanged")
        self.assertIsNone(identical["commit"])
        self.assertIsNone(PAGES.git(self.repo, "rev-parse", "--verify", "--quiet",
                                   "refs/heads/pages-update/" + "b" * 40, optional=True))
        (self.source / "index.html").write_text("changed app", encoding="utf-8")
        changed = PAGES.prepare(self.repo, self.source, "c" * 40, RUN_URL)
        self.assertTrue(changed["new_commit"])
        self.assertEqual(PAGES.git(self.repo, "rev-parse", f"{changed['commit']}^"), first["commit"])
        self.assertIn("main " + "c" * 40, PAGES.git(self.repo, "show", "-s", "--format=%B", changed["commit"]))

    def test_snapshot_retains_ignored_files_and_removes_deleted_files(self):
        (self.source / ".gitignore").write_text("ignored.bin\n", encoding="utf-8")
        (self.source / "ignored.bin").write_bytes(b"\x00\xff")
        first = PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", first["commit"],
                                  "public_html/ignored.bin"), "public_html/ignored.bin")
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", first["commit"])
        (self.source / "ignored.bin").unlink()
        changed = PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", changed["commit"],
                                  "public_html/ignored.bin"), "")

    def test_git_filters_cannot_execute_or_change_artifact_bytes(self):
        (self.source / ".gitattributes").write_text("*.txt text eol=lf filter=fail\n", encoding="utf-8")
        content = b"first\r\nsecond\r\n"
        (self.source / "preserved.txt").write_bytes(content)
        with patch.dict(PAGES.os.environ, {
            "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "filter.fail.clean",
            "GIT_CONFIG_VALUE_0": "false", "GIT_CONFIG_KEY_1": "filter.fail.required",
            "GIT_CONFIG_VALUE_1": "true",
        }):
            result = PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        actual = PAGES.subprocess.check_output([
            "git", "-C", str(self.repo), "show", f"{result['commit']}:public_html/preserved.txt",
        ])
        self.assertEqual(actual, content)

    def test_missing_files_headers_and_invalid_sha_fail_before_git_mutation(self):
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, "bad", RUN_URL)
        (self.source / "_headers").write_text("/*\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        (self.source / "index.html").unlink()
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL)
        self.assertFalse(self.repo.exists())

    def test_symlinks_git_metadata_and_oversized_files_are_rejected(self):
        invalid = self.source / "link"
        invalid.symlink_to(self.source / "index.html")
        with self.assertRaises(RuntimeError):
            PAGES.validate_tree(self.source)
        invalid.unlink()
        (self.source / ".git").mkdir()
        (self.source / ".git/config").touch()
        with self.assertRaises(RuntimeError):
            PAGES.validate_tree(self.source)
        (self.source / ".git/config").unlink()
        (self.source / ".git").rmdir()
        with (self.source / "large.wasm").open("wb") as output:
            output.truncate(25 * 1024 * 1024)
        with self.assertRaisesRegex(RuntimeError, "25 MiB"):
            PAGES.validate_tree(self.source)

    def test_file_count_is_strictly_below_20000(self):
        for index in range(19997):
            (self.source / f"file-{index}").touch()
        self.assertEqual(PAGES.validate_tree(self.source)["files"], 19999)
        (self.source / "one-too-many").touch()
        with self.assertRaisesRegex(RuntimeError, "fewer than 20000"):
            PAGES.validate_tree(self.source)

    def archive(self, extra=None):
        archive = self.root / "artifact.zip"
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr("index.html", "verified app")
            output.writestr("_headers", HEADERS)
            if extra:
                output.writestr(*extra)
        digest = "sha256:" + hashlib.sha256(archive.read_bytes()).hexdigest()
        return archive, digest

    def test_archive_digest_and_layout(self):
        archive, digest = self.archive()
        destination = self.root / "downloaded"
        destination.mkdir()
        with self.assertRaisesRegex(RuntimeError, "SHA-256"):
            PAGES.extract_archive(archive, destination, "sha256:" + "0" * 64)
        PAGES.extract_archive(archive, destination, digest)
        self.assertEqual((destination / "index.html").read_text(), "verified app")

    def test_archive_traversal_duplicate_and_symlink_entries(self):
        link = zipfile.ZipInfo("link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entry in [("../escape", "bad"), ("/absolute", "bad"), (".git/config", "bad"),
                      ("index.html", "duplicate"), (link, "index.html")]:
            with self.subTest(entry=entry):
                archive, digest = self.archive(entry)
                with tempfile.TemporaryDirectory(dir=self.root) as directory:
                    with self.assertRaises(RuntimeError):
                        PAGES.extract_archive(archive, Path(directory), digest)
        self.assertFalse((self.root / "escape").exists())

    def test_run_gates_reject_non_main_fork_pr_failure_and_skipped_checks(self):
        api = FakeAPI()
        self.assertTrue(PAGES.full_build(api, api.run))
        for field, value in [("event", "pull_request"), ("head_branch", "pages"),
                             ("conclusion", "failure"), ("status", "in_progress"),
                             ("path", ".github/workflows/other.yml"),
                             ("head_repository", {"full_name": "fork/project"})]:
            candidate = {**api.run, field: value}
            self.assertFalse(PAGES.full_build(api, candidate))
        api.jobs[0]["conclusion"] = "skipped"
        self.assertFalse(PAGES.full_build(api, api.run))
        self.assertEqual(PAGES.publish(api, 7, self.repo)["status"], "skipped")
        self.assertFalse(self.repo.exists())
        self.assertEqual(api.writes, [])

    def test_artifact_must_match_exact_run_sha_and_digest(self):
        api = FakeAPI()
        self.assertEqual(PAGES.artifact_for(api, api.run)["id"], 90)
        good = copy.deepcopy(api.artifacts[0])
        for mutation in [{"expired": True}, {"digest": None}, {"name": "ci-build-7"},
                         {"workflow_run": {"id": 9, "head_branch": "main", "head_sha": SHA}}]:
            api.artifacts = [{**good, **mutation}]
            with self.assertRaises(RuntimeError):
                PAGES.artifact_for(api, api.run)
        api.artifacts = []
        with self.assertRaises(RuntimeError):
            PAGES.artifact_for(api, api.run)

    def test_older_success_cannot_supersede_newer_full_build(self):
        api = FakeAPI()
        newer = run_info(8)
        api.runs = [newer, api.run]
        api.artifacts = [artifact(newer)]
        result = PAGES.publish(api, 7, self.repo)
        self.assertEqual(result["status"], "skipped")
        self.assertIn("newer", result["reason"])
        self.assertFalse(self.repo.exists())
        self.assertEqual(api.writes, [])

    def test_pr_creation_closes_only_managed_prs_after_creation(self):
        api = FakeAPI()
        api.prs = [{"number": 3, "head": {"ref": "pages-update/" + "b" * 40,
                                           "repo": {"full_name": api.repository}}},
                   {"number": 4, "head": {"ref": "human-change", "repo": {"full_name": api.repository}}}]
        result = {"status": "prepared", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        self.assertIn("/pull/200", PAGES.reconcile_prs(api, result))
        self.assertEqual(api.writes[0][1], "POST")
        self.assertEqual(api.writes[0][2]["base"], "pages")
        self.assertIn("- [ ] 実機で確認した", api.writes[0][2]["body"])
        self.assertEqual(api.writes[-1], ("pulls/3", "PATCH", {"state": "closed"}))
        api.writes.clear()
        result["status"] = "unchanged"
        self.assertIsNone(PAGES.reconcile_prs(api, result))
        self.assertEqual(api.writes, [("pulls/3", "PATCH", {"state": "closed"})])

    def test_failed_pr_creation_does_not_close_existing_approval(self):
        api = FakeAPI()
        api.prs = [{"number": 3, "head": {"ref": "pages-update/" + "b" * 40,
                                           "repo": {"full_name": api.repository}}}]
        result = {"status": "prepared", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        with patch.object(api, "request", side_effect=RuntimeError("PR creation denied")) as request:
            with self.assertRaises(RuntimeError):
                PAGES.reconcile_prs(api, result)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[:2], ("pulls", "POST"))

    def test_existing_approval_is_updated_without_duplicate_pr(self):
        api = FakeAPI()
        api.prs = [{"number": 3, "html_url": "https://github.com/example/project/pull/3",
                    "head": {"ref": "pages-update/" + SHA, "repo": {"full_name": api.repository}}}]
        result = {"status": "existing", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        self.assertTrue(PAGES.reconcile_prs(api, result).endswith("/3"))
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0][:2], ("pulls/3", "PATCH"))


if __name__ == "__main__":
    unittest.main()
