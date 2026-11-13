import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("publish_pages", ROOT / "scripts/publish-pages.py")
PAGES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PAGES)
HEADERS = "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n"
SHA = "a" * 40
RUN_URL = "https://github.com/example/project/actions/runs/7"
COMMIT_DATE = "2026-11-13T09:00:00Z"


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


def approval(number, branch, repository="example/project"):
    return {"number": number, "state": "open",
            "html_url": f"https://github.com/example/project/pull/{number}",
            "base": {"ref": "pages", "repo": {"full_name": "example/project"}},
            "head": {"ref": branch, "repo": {"full_name": repository}}}


class FakeAPI:
    repository = "example/project"

    def __init__(self):
        self.run = run_info()
        self.jobs = [{"name": name, "conclusion": "success"} for name in PAGES.REQUIRED_JOBS]
        self.artifacts = [artifact(self.run)]
        self.runs = [self.run]
        self.prs = []
        self.branches = []
        self.writes = []

    def request(self, path, method="GET", body=None):
        if method == "GET":
            return self.run
        self.writes.append((path, method, body))
        if path == "pulls" and method == "POST":
            self.prs.append(approval(200, body["head"]))
        if path.startswith("pulls/") and body == {"state": "closed"}:
            self.prs = [pr for pr in self.prs if pr["number"] != int(path.split("/")[1])]
        if method == "DELETE":
            self.branches = [branch for branch in self.branches
                             if path != f"git/refs/heads/{branch['name']}"]
        return {"number": 200, "html_url": "https://github.com/example/project/pull/200"}

    def items(self, path, key=None):
        if path == "branches":
            return iter(self.branches)
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
        first = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        self.assertTrue(first["bootstrap_created"])
        self.assertTrue(first["new_commit"])
        base = first["base_commit"]
        self.assertEqual(PAGES.git(self.repo, "rev-list", "--parents", "-n", "1", base), base)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", base).splitlines(),
                         ["README.md", "public_html"])
        self.assertNotEqual(PAGES.git(self.repo, "show", f"{base}:public_html/index.html"), "verified app")
        self.assertEqual(PAGES.git(self.repo, "show", f"{first['commit']}:public_html/index.html"), "verified app")
        again = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        self.assertEqual(again["status"], "existing")
        self.assertFalse(again["new_commit"])
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", first["commit"])
        identical = PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL, "2026-11-14T09:00:00Z")
        self.assertEqual(identical["status"], "unchanged")
        self.assertIsNone(identical["commit"])
        self.assertIsNone(PAGES.git(self.repo, "rev-parse", "--verify", "--quiet",
                                   "refs/heads/pages-update/" + "b" * 40, optional=True))
        (self.source / "index.html").write_text("changed app", encoding="utf-8")
        changed = PAGES.prepare(self.repo, self.source, "c" * 40, RUN_URL, COMMIT_DATE)
        self.assertTrue(changed["new_commit"])
        self.assertEqual(PAGES.git(self.repo, "rev-parse", f"{changed['commit']}^"), first["commit"])
        self.assertIn("main " + "c" * 40, PAGES.git(self.repo, "show", "-s", "--format=%B", changed["commit"]))

    def test_snapshot_retains_ignored_files_and_removes_deleted_files(self):
        (self.source / ".gitignore").write_text("ignored.bin\n", encoding="utf-8")
        (self.source / "ignored.bin").write_bytes(b"\x00\xff")
        first = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", first["commit"],
                                  "public_html/ignored.bin"), "public_html/ignored.bin")
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", first["commit"])
        (self.source / "ignored.bin").unlink()
        changed = PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL, COMMIT_DATE)
        self.assertEqual(PAGES.git(self.repo, "ls-tree", "--name-only", changed["commit"],
                                  "public_html/ignored.bin"), "")

    def test_main_placeholder_does_not_replace_verified_artifact(self):
        PAGES.init_repo(self.repo)
        placeholder = self.root / "main-placeholder"
        placeholder.mkdir()
        content = '<meta name="gogo-fpga-placeholder" content="main">'
        (placeholder / "index.html").write_text(content, encoding="utf-8")
        main = PAGES.commit(self.repo, PAGES.snapshot(self.repo, placeholder), "mainの案内")
        PAGES.git(self.repo, "update-ref", "refs/heads/main", main)
        result = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        self.assertEqual(PAGES.git(self.repo, "show", f"{main}:public_html/index.html"), content)
        self.assertEqual(PAGES.git(self.repo, "show", f"{result['commit']}:public_html/index.html"),
                         "verified app")
        self.assertEqual(PAGES.git(self.repo, "show", f"{result['commit']}:public_html/_headers"),
                         HEADERS.strip())
        self.assertEqual(PAGES.git(self.repo, "rev-parse", "refs/heads/main"), main)

    def test_provenance_overlay_preserves_every_other_artifact_byte(self):
        (self.source / "publication-info.json").write_text("null\n")
        (self.source / "build-info.json").write_text('{"artifacts": {"tool.wasm": "verified hash"}}\n')
        (self.source / "binary.wasm").write_bytes(b"\x00\xff\r\n")
        original = {p.name: p.read_bytes() for p in self.source.iterdir()}
        result = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        info = json.loads(PAGES.git(self.repo, "show", f"{result['commit']}:public_html/publication-info.json"))
        self.assertEqual(info, {"sha": SHA, "short_sha": SHA[:7], "run_url": RUN_URL,
                                "commit_date": COMMIT_DATE})
        self.assertEqual(result["files"], len(original))
        self.assertEqual(result["bytes"], sum(len(value) for name, value in original.items()
                                            if name != "publication-info.json") +
                         len(PAGES.publication_info(SHA, RUN_URL, COMMIT_DATE).encode()))
        for name, content in original.items():
            self.assertEqual((self.source / name).read_bytes(), content)
            if name != "publication-info.json":
                actual = PAGES.subprocess.check_output([
                    "git", "-C", str(self.repo), "show", f"{result['commit']}:public_html/{name}"])
                self.assertEqual(actual, content)
        changed_metadata = PAGES.prepare(self.repo, self.source, SHA, RUN_URL.replace("/7", "/8"),
                                         "2026-11-14T09:00:00Z")
        self.assertEqual(changed_metadata["status"], "existing")
        self.assertEqual(changed_metadata["commit"], result["commit"])
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", result["commit"])
        unchanged = PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL, COMMIT_DATE)
        self.assertEqual(unchanged["status"], "unchanged")
        self.assertEqual(json.loads(PAGES.git(self.repo, "show", "pages:public_html/publication-info.json")), info)
        (self.source / "build-info.json").write_text('{"artifacts": {"tool.wasm": "changed hash"}}\n')
        self.assertEqual(PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL, COMMIT_DATE)["status"],
                         "prepared")
        (self.source / "build-info.json").write_bytes(original["build-info.json"])
        (self.source / "_headers").write_text(HEADERS + "  X-Test: changed\n")
        self.assertEqual(PAGES.prepare(self.repo, self.source, "b" * 40, RUN_URL, COMMIT_DATE)["status"],
                         "prepared")

    def test_legacy_pages_without_metadata_are_unchanged(self):
        PAGES.init_repo(self.repo)
        legacy = PAGES.commit(self.repo, PAGES.snapshot(self.repo, self.source), "legacy")
        PAGES.git(self.repo, "update-ref", "refs/heads/pages", legacy)
        result = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        self.assertEqual(result["status"], "unchanged")

    def test_invalid_provenance_fails_before_repository_mutation(self):
        for url, date in [("https://example.com/run/7", COMMIT_DATE), (RUN_URL, "bad"),
                          (RUN_URL, "2026-02-30T09:00:00Z")]:
            with self.subTest(url=url, date=date), self.assertRaises((RuntimeError, ValueError)):
                PAGES.prepare(self.repo, self.source, SHA, url, date)
        self.assertFalse(self.repo.exists())
        (self.source / "publication-info.json").mkdir()
        with self.assertRaisesRegex(RuntimeError, "must be a file"):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)

    def test_commit_date_comes_from_the_exact_source_commit(self):
        api = FakeAPI()
        with patch.object(api, "request", return_value={"sha": SHA, "commit": {
                "committer": {"date": COMMIT_DATE}}}) as request:
            self.assertEqual(PAGES.source_commit_date(api, SHA), COMMIT_DATE)
            request.assert_called_once_with(f"commits/{SHA}")
        with patch.object(api, "request", return_value={"sha": "b" * 40}):
            with self.assertRaisesRegex(RuntimeError, "does not match"):
                PAGES.source_commit_date(api, SHA)

    def test_git_filters_cannot_execute_or_change_artifact_bytes(self):
        (self.source / ".gitattributes").write_text("*.txt text eol=lf filter=fail\n", encoding="utf-8")
        content = b"first\r\nsecond\r\n"
        (self.source / "preserved.txt").write_bytes(content)
        with patch.dict(PAGES.os.environ, {
            "GIT_CONFIG_COUNT": "2", "GIT_CONFIG_KEY_0": "filter.fail.clean",
            "GIT_CONFIG_VALUE_0": "false", "GIT_CONFIG_KEY_1": "filter.fail.required",
            "GIT_CONFIG_VALUE_1": "true",
        }):
            result = PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        actual = PAGES.subprocess.check_output([
            "git", "-C", str(self.repo), "show", f"{result['commit']}:public_html/preserved.txt",
        ])
        self.assertEqual(actual, content)

    def test_missing_files_headers_and_invalid_sha_fail_before_git_mutation(self):
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, "bad", RUN_URL, COMMIT_DATE)
        (self.source / "_headers").write_text("/*\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
        (self.source / "index.html").unlink()
        with self.assertRaises(RuntimeError):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
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
        with self.assertRaisesRegex(RuntimeError, "fewer than 20000"):
            PAGES.prepare(self.repo, self.source, SHA, RUN_URL, COMMIT_DATE)
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
        old = "pages-update/" + "b" * 40
        api.prs = [approval(3, old), approval(4, "human-change")]
        result = {"status": "prepared", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        self.assertIn("/pull/200", PAGES.reconcile_prs(api, result))
        self.assertEqual(api.writes[0][1], "POST")
        self.assertEqual(api.writes[0][2]["base"], "pages")
        self.assertIn("- [ ] 実機で確認した", api.writes[0][2]["body"])
        self.assertEqual(api.writes[-2:], [("pulls/3", "PATCH", {"state": "closed"}),
                                          (f"git/refs/heads/{old}", "DELETE", None)])
        api.writes.clear()
        api.prs = [approval(3, old)]
        result["status"] = "unchanged"
        self.assertIsNone(PAGES.reconcile_prs(api, result))
        self.assertEqual(api.writes, [("pulls/3", "PATCH", {"state": "closed"}),
                                     (f"git/refs/heads/{old}", "DELETE", None)])

    def test_failed_pr_creation_does_not_close_existing_approval(self):
        api = FakeAPI()
        api.prs = [approval(3, "pages-update/" + "b" * 40)]
        result = {"status": "prepared", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        with patch.object(api, "request", side_effect=RuntimeError("PR creation denied")) as request:
            with self.assertRaises(RuntimeError):
                PAGES.reconcile_prs(api, result)
            self.assertEqual(request.call_count, 1)
            self.assertEqual(request.call_args.args[:2], ("pulls", "POST"))

    def test_existing_approval_is_updated_without_duplicate_pr(self):
        api = FakeAPI()
        api.prs = [approval(3, "pages-update/" + SHA)]
        result = {"status": "existing", "branch": "pages-update/" + SHA, "main_sha": SHA,
                  "run_url": RUN_URL, "files": 2, "bytes": 100}
        self.assertTrue(PAGES.reconcile_prs(api, result).endswith("/3"))
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0][:2], ("pulls/3", "PATCH"))

    def cleanup_result(self, status="unchanged"):
        return {"status": status, "branch": "pages-update/" + SHA, "main_sha": SHA,
                "run_url": RUN_URL, "files": 2, "bytes": 100}

    def test_sweep_orphans_on_unchanged_run_preserves_unmanaged_and_fork_heads(self):
        api = FakeAPI()
        orphans = ["pages-update/" + char * 40 for char in "bcde"]
        preserved = ["pages", "main", "pages-update/" + "F" * 40,
                     "pages-update/" + "a" * 39, "pages-update/" + SHA + "/extra",
                     "human-change", "pages-update/" + "f" * 40]
        api.branches = [{"name": name} for name in orphans + preserved]
        api.prs = [approval(4, preserved[-1], "fork/project"), approval(5, "human-change")]
        PAGES.reconcile_prs(api, self.cleanup_result())
        self.assertEqual(api.writes, [(f"git/refs/heads/{name}", "DELETE", None) for name in orphans])
        self.assertEqual(api.branches, [{"name": name} for name in preserved])
        api.writes.clear()
        PAGES.reconcile_prs(api, self.cleanup_result())
        self.assertEqual(api.writes, [])

    def test_empty_cleanup_inventory_is_a_noop(self):
        api = FakeAPI()
        self.assertIsNone(PAGES.reconcile_prs(api, self.cleanup_result()))
        self.assertEqual(api.writes, [])

    def test_malformed_created_approval_never_closes_or_deletes_existing_heads(self):
        for response in [None, {}, {"number": 200}, {"number": True, "html_url": "invalid"}]:
            with self.subTest(response=response):
                api = FakeAPI()
                api.prs = [approval(3, "pages-update/" + "b" * 40)]
                with patch.object(api, "request", return_value=response) as request:
                    with self.assertRaises(RuntimeError):
                        PAGES.reconcile_prs(api, self.cleanup_result("prepared"))
                    self.assertEqual(request.call_count, 1)
                    self.assertEqual(request.call_args.args[:2], ("pulls", "POST"))

    def test_current_open_approval_and_newly_observed_approval_are_preserved(self):
        api = FakeAPI()
        current, orphan = "pages-update/" + SHA, "pages-update/" + "b" * 40
        api.prs = [approval(3, current)]
        api.branches = [{"name": current}, {"name": orphan}]
        original = api.items
        calls = 0

        def listing(path, key=None):
            nonlocal calls
            if path.startswith("pulls?"):
                calls += 1
                if calls == 2:
                    api.prs.append(approval(4, orphan))
            return original(path, key)

        with patch.object(api, "items", side_effect=listing):
            PAGES.reconcile_prs(api, self.cleanup_result("existing"))
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0][:2], ("pulls/3", "PATCH"))

    def test_listing_errors_and_malformed_rows_never_delete_any_branch(self):
        for failure in ["branches", "pulls-first", "pulls-final", "branch-row", "pr-row",
                        "head-repo", "base", "state", "url", "duplicate-branch", "duplicate-pr"]:
            with self.subTest(failure=failure):
                api = FakeAPI()
                api.branches = [{"name": "pages-update/" + "b" * 40}]
                api.prs = [approval(3, "pages-update/" + SHA)]
                if failure == "branch-row":
                    api.branches.append({"name": None})
                if failure == "pr-row":
                    api.prs.append({"head": {}})
                if failure == "head-repo":
                    api.prs[0]["head"]["repo"] = {}
                if failure == "base":
                    api.prs[0]["base"]["ref"] = "main"
                if failure == "state":
                    api.prs[0]["state"] = "closed"
                if failure == "url":
                    del api.prs[0]["html_url"]
                if failure == "duplicate-branch":
                    api.branches *= 2
                if failure == "duplicate-pr":
                    api.prs *= 2
                original = api.items
                calls = 0

                def listing(path, key=None):
                    nonlocal calls
                    if path.startswith("pulls?"):
                        calls += 1
                    if ((failure == "branches" and path == "branches") or
                            (failure == "pulls-first" and calls == 1) or
                            (failure == "pulls-final" and calls == 2)):
                        raise RuntimeError("Listing failed")
                    return original(path, key)

                with patch.object(api, "items", side_effect=listing), self.assertRaises(RuntimeError):
                    PAGES.reconcile_prs(api, self.cleanup_result("existing"))
                self.assertFalse(any(method == "DELETE" for _, method, _ in api.writes))

    def test_delete_idempotency_and_other_http_errors(self):
        branch = "pages-update/" + SHA
        for code, absent in [(404, False), (422, True), (422, False), (403, False), (500, False)]:
            with self.subTest(code=code, absent=absent):
                api = FakeAPI()

                def request(path, method="GET", body=None):
                    if method == "DELETE":
                        raise urllib.error.HTTPError("https://api.github.com", code, "error", {}, None)
                    if absent:
                        raise urllib.error.HTTPError("https://api.github.com", 404, "absent", {}, None)
                    return {"ref": "refs/heads/" + branch}

                with patch.object(api, "request", side_effect=request) as mocked:
                    if code == 404 or (code == 422 and absent):
                        PAGES.delete_managed_branch(api, branch)
                    else:
                        with self.assertRaises(urllib.error.HTTPError):
                            PAGES.delete_managed_branch(api, branch)
                    if code == 422:
                        self.assertEqual(mocked.call_args.args, (f"git/ref/heads/{branch}",))
        with self.assertRaises(RuntimeError):
            PAGES.delete_managed_branch(FakeAPI(), "pages")

    def test_cleanup_paginates_both_lists_before_deleting(self):
        api = PAGES.GitHub.__new__(PAGES.GitHub)
        api.repository = "example/project"
        names = ["pages-update/" + f"{number:040x}" for number in range(101)]
        requests = []

        def request(path, method="GET", body=None):
            requests.append((path, method))
            if method == "DELETE":
                return None
            if path.startswith("branches?"):
                start = 0 if path.endswith("page=1") else 100
                return [{"name": name} for name in names[start:start + 100]]
            if path.startswith("pulls?"):
                start = 0 if path.endswith("page=1") else 100
                return [approval(number + 1, names[number], "fork/project")
                        for number in range(start, min(start + 100, 100))]
            self.fail(path)

        with patch.object(api, "request", side_effect=request):
            PAGES.reconcile_prs(api, self.cleanup_result())
        self.assertEqual(requests[-1], (f"git/refs/heads/{names[-1]}", "DELETE"))
        self.assertEqual(sum(method == "DELETE" for _, method in requests), 1)
        self.assertIn(("branches?per_page=100&page=2", "GET"), requests)
        self.assertEqual(requests.count(("pulls?state=open&base=pages&per_page=100&page=2", "GET")), 2)

    def test_malformed_pagination_and_late_page_errors_prevent_deletion(self):
        for response in [{}, {"jobs": {}}, None, "not a list"]:
            api = PAGES.GitHub.__new__(PAGES.GitHub)
            with patch.object(api, "request", return_value=response), self.assertRaises(RuntimeError):
                list(api.items("branches"))
        api = PAGES.GitHub.__new__(PAGES.GitHub)
        with patch.object(api, "request", return_value={"jobs": {}}), self.assertRaises(RuntimeError):
            list(api.items("jobs", "jobs"))
        api.repository = "example/project"
        first = [{"name": "pages-update/" + f"{number:040x}"} for number in range(100)]
        with patch.object(api, "request", side_effect=[first, RuntimeError("page 2 failed")]) as request:
            with self.assertRaises(RuntimeError):
                PAGES.reconcile_prs(api, self.cleanup_result())
            self.assertEqual(request.call_count, 2)
            self.assertTrue(all(len(call.args) == 1 for call in request.call_args_list))

    def test_delete_response_has_no_json_body(self):
        api = PAGES.GitHub.__new__(PAGES.GitHub)
        api.repository, api.token = "example/project", "fake-test-token"
        with patch.object(PAGES.urllib.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value.status = 204
            self.assertIsNone(api.request("git/refs/heads/pages-update/" + SHA, "DELETE"))


if __name__ == "__main__":
    unittest.main()
