#!/usr/bin/env python3

import argparse
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import runpy
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile


SHA = re.compile(r"[0-9a-f]{40}")
MANAGED_BRANCH = re.compile(r"pages-update/[0-9a-f]{40}")
BUILD_INFO = "publication-info.json"
REQUIRED_JOBS = {"Build", "Playwright E2E", "Simulation shard coverage",
                 "Pyodide gowin_pack (cpu)", "Pyodide gowin_pack (hdl)"}
BRANCH_README = """# 午後のFPGAの配信用生成物

このブランチはCIが生成します。public_html/とこのREADME以外を置かず、手で編集しません。
更新元のmain SHAとbuild runは、各コミットと公開承認PRに記録します。
実機確認後、人間がpages-update/からのPRをマージして公開を承認します。
初期状態は承認待ちの案内だけです。エージェントはPRをマージしません。
"""
BOOTSTRAP_HTML = """<!doctype html>
<html lang="ja"><meta charset="utf-8"><title>午後のFPGA</title>
<p>午後のFPGAの公開は承認待ちです。</p></html>
"""
DIST_CHECK = runpy.run_path(str(Path(__file__).with_name("check-dist-size.py")))


def validate_tree(source):
    DIST_CHECK["check_dist"](source)
    paths = sorted(p for p in source.rglob("*") if p.is_file())
    for path in source.rglob("*"):
        parts = path.relative_to(source).parts
        if any(part.lower() == ".git" or "\\" in part or
               any(ord(c) < 32 for c in part) for part in parts):
            raise RuntimeError(f"Unsafe distribution path: {path}")
    for name in ("index.html", "_headers"):
        if not (source / name).is_file():
            raise RuntimeError(f"Distribution is missing {name}")
    headers = (source / "_headers").read_text(encoding="utf-8")
    if not all(re.search(pattern, headers, re.MULTILINE) for pattern in (
        r"^/\*\s*$", r"^\s+Cross-Origin-Opener-Policy: same-origin\s*$",
        r"^\s+Cross-Origin-Embedder-Policy: require-corp\s*$",
    )):
        raise RuntimeError("Distribution isolation headers are missing")
    return {"files": len(paths), "bytes": sum(p.stat().st_size for p in paths)}


def git(repo, *args, env=None, data=None, optional=False):
    result = subprocess.run(["git", "-C", str(repo), *args], input=data,
                            text=True, capture_output=True, env=env, check=False)
    if result.returncode:
        if optional and result.returncode == 1:
            return None
        raise RuntimeError(f"git {args[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def init_repo(repo):
    if not (repo / ".git").is_dir():
        if repo.exists() and any(repo.iterdir()):
            raise RuntimeError("The delivery Git directory must be empty or a Git repository")
        subprocess.run(["git", "init", "--initial-branch=delivery", str(repo)],
                       check=True, capture_output=True)


def snapshot(repo, source, build_info=None):
    def subtree(directory):
        entries = []
        for path in sorted(directory.iterdir()):
            if directory == source and path.name == BUILD_INFO and build_info is not None:
                continue
            if path.is_dir():
                entries.append(f"040000 tree {subtree(path)}\t{path.name}\0")
            else:
                blob = git(repo, "hash-object", "-w", "--no-filters", "--", str(path))
                entries.append(f"100644 blob {blob}\t{path.name}\0")
        if directory == source and build_info is not None:
            blob = git(repo, "hash-object", "-w", "--stdin", data=build_info)
            entries.append(f"100644 blob {blob}\t{BUILD_INFO}\0")
        return git(repo, "mktree", "-z", data="".join(entries))

    readme = git(repo, "hash-object", "-w", "--stdin", data=BRANCH_README)
    return git(repo, "mktree", "-z", data=(
        f"100644 blob {readme}\tREADME.md\0"
        f"040000 tree {subtree(source)}\tpublic_html\0"))


def commit(repo, tree, message, parent=None):
    env = {**os.environ, "GIT_AUTHOR_NAME": "github-actions[bot]",
           "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
           "GIT_COMMITTER_NAME": "github-actions[bot]",
           "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com"}
    return git(repo, "commit-tree", tree, *(["-p", parent] if parent else []),
               env=env, data=message + "\n")


def publication_info(sha, run_url, commit_date):
    if not SHA.fullmatch(sha):
        raise RuntimeError("The source main SHA must be 40 lowercase hexadecimal characters")
    if not re.fullmatch(r"https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[1-9][0-9]{0,19}", run_url):
        raise RuntimeError("Invalid build run URL")
    if datetime.strptime(commit_date, "%Y-%m-%dT%H:%M:%SZ").strftime("%Y-%m-%dT%H:%M:%SZ") != commit_date:
        raise RuntimeError("Invalid UTC commit date")
    return json.dumps({"sha": sha, "short_sha": sha[:7], "run_url": run_url,
                       "commit_date": commit_date}, sort_keys=True) + "\n"


def same_content(repo, first, second):
    return not git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", first, second,
                   "--", ".", f":(exclude)public_html/{BUILD_INFO}")


def source_commit_date(api, sha):
    origin = api.request(f"commits/{sha}")
    if origin["sha"] != sha:
        raise RuntimeError("Commit metadata does not match the validated build")
    return origin["commit"]["committer"]["date"]


def prepare(repo, source, sha, run_url, commit_date):
    info = publication_info(sha, run_url, commit_date)
    summary = validate_tree(source)
    reserved = source / BUILD_INFO
    if reserved.exists() and not reserved.is_file():
        raise RuntimeError("The publication metadata path must be a file")
    summary["files"] += 0 if reserved.exists() else 1
    summary["bytes"] += len(info.encode()) - (reserved.stat().st_size if reserved.exists() else 0)
    if summary["files"] >= DIST_CHECK["MAX_FILES"]:
        raise RuntimeError("Published tree must contain fewer than 20000 files")
    init_repo(repo)
    tree = snapshot(repo, source, info)
    base = git(repo, "rev-parse", "--verify", "--quiet", "refs/heads/pages", optional=True)
    bootstrap = base is None
    if bootstrap:
        with tempfile.TemporaryDirectory(prefix="pages-bootstrap-", dir=repo.parent) as directory:
            placeholder = Path(directory)
            (placeholder / "index.html").write_text(BOOTSTRAP_HTML, encoding="utf-8")
            base = commit(repo, snapshot(repo, placeholder), "Pagesの承認待ちブランチを初期化する")
        git(repo, "update-ref", "refs/heads/pages", base)
    result = {**summary, "main_sha": sha, "run_url": run_url,
              "bootstrap_created": bootstrap, "base_commit": base,
              "branch": f"pages-update/{sha}", "new_commit": False}
    if same_content(repo, base, tree):
        return {**result, "status": "unchanged", "commit": None}
    ref = f"refs/heads/{result['branch']}"
    previous = git(repo, "rev-parse", "--verify", "--quiet", ref, optional=True)
    if previous and same_content(repo, previous, tree):
        return {**result, "status": "existing", "commit": previous}
    candidate = commit(repo, tree, f"main {sha} の検証済みWeb配布物を更新する\n\n{run_url}",
                       parent=previous or base)
    git(repo, "update-ref", ref, candidate)
    return {**result, "status": "prepared", "commit": candidate, "new_commit": True}


class GitHub:
    def __init__(self, repository):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise RuntimeError("Invalid GitHub repository")
        self.repository = repository
        self.token = os.environ["GH_TOKEN"]

    def request(self, path, method="GET", body=None):
        request = urllib.request.Request(
            f"https://api.github.com/repos/{self.repository}/{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28"},
            method=method)
        with urllib.request.urlopen(request, timeout=60) as response:
            return None if response.status == 204 else json.load(response)

    def items(self, path, key=None):
        separator = "&" if "?" in path else "?"
        page = 1
        while True:
            response = self.request(f"{path}{separator}per_page=100&page={page}")
            if key and (not isinstance(response, dict) or key not in response):
                raise RuntimeError("Malformed paginated API response")
            values = response[key] if key else response
            if not isinstance(values, list):
                raise RuntimeError("Expected an API result list")
            yield from values
            if len(values) < 100:
                break
            page += 1


def full_build(api, run):
    if not (run["event"] == "push" and run["head_branch"] == "main" and
            run["conclusion"] == "success" and run["status"] == "completed" and
            run["path"] == ".github/workflows/build.yml" and
            run["head_repository"]["full_name"] == api.repository and
            run["repository"]["full_name"] == api.repository):
        return False
    jobs = list(api.items(f"actions/runs/{run['id']}/jobs", "jobs"))
    return REQUIRED_JOBS <= {job["name"] for job in jobs if job["conclusion"] == "success"}


def artifact_for(api, run):
    matches = [artifact for artifact in api.items(f"actions/runs/{run['id']}/artifacts", "artifacts")
               if artifact["name"] == f"gogo-fpga-web-{run['head_sha']}"]
    if len(matches) != 1:
        raise RuntimeError("Exactly one validated public_html artifact is required")
    artifact = matches[0]
    origin = artifact["workflow_run"]
    if (artifact["expired"] or origin["id"] != run["id"] or
            origin["head_branch"] != "main" or origin["head_sha"] != run["head_sha"] or
            not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest") or "")):
        raise RuntimeError("Artifact origin, expiry or digest is invalid")
    return artifact


def extract_archive(archive, destination, digest):
    with archive.open("rb") as source:
        actual = "sha256:" + hashlib.file_digest(source, "sha256").hexdigest()
    if actual != digest:
        raise RuntimeError("Artifact ZIP SHA-256 differs from GitHub metadata")
    seen = set()
    files = 0
    with zipfile.ZipFile(archive) as zipped:
        for item in zipped.infolist():
            name = PurePosixPath(item.filename)
            mode = stat.S_IFMT(item.external_attr >> 16)
            if (name.is_absolute() or "\\" in item.filename or
                    any(p in ("", ".", "..") or p.lower() == ".git" or
                        any(ord(c) < 32 for c in p) for p in item.orig_filename.rstrip("/").split("/")) or
                    mode not in (0, stat.S_IFREG, stat.S_IFDIR) or name in seen):
                raise RuntimeError("Unsafe or duplicate artifact ZIP entry")
            seen.add(name)
            if item.is_dir():
                (destination / name).mkdir(parents=True, exist_ok=True)
                continue
            files += 1
            if files >= DIST_CHECK["MAX_FILES"]:
                raise RuntimeError("Artifact must contain fewer than 20000 files")
            if item.file_size >= DIST_CHECK["MAX_FILE_BYTES"]:
                raise RuntimeError("Artifact file is at least 25 MiB")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zipped.open(item) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
    validate_tree(destination)


def pr_body(result):
    return (f"## 公開する生成物\n\nmain SHA: `{result['main_sha']}`\n\n"
            f"[成功したbuild run]({result['run_url']})のpublic_html成果物を使用します。"
            f"公開元のpublication-info.jsonだけを付け、アプリは再ビルドも変更もしていません。\n\nファイル数: {result['files']}\n\n"
            f"合計サイズ: {result['bytes']} bytes\n\n"
            "Cloudflareのpages-update/*のpreview URLで確認してください。"
            "このPRのマージが本番公開の承認です。エージェントはマージしません。\n\n"
            "- [ ] 実機で確認した\n- [ ] 配信ヘッダーと書き込み結果を確認し、公開を承認する\n")


def open_page_prs(api):
    prs = list(api.items("pulls?state=open&base=pages"))
    numbers = set()
    for pr in prs:
        if not isinstance(pr, dict):
            raise RuntimeError("Malformed open approval PR")
        head, base = pr.get("head"), pr.get("base")
        if (type(pr.get("number")) is not int or pr["number"] <= 0 or
                pr["number"] in numbers or pr.get("state") != "open" or
                not isinstance(pr.get("html_url"), str) or
                pr["html_url"] != f"https://github.com/{api.repository}/pull/{pr['number']}" or
                not isinstance(head, dict) or not isinstance(head.get("ref"), str) or
                not head["ref"] or not isinstance(base, dict) or base.get("ref") != "pages" or
                not isinstance(base.get("repo"), dict) or
                base["repo"].get("full_name") != api.repository):
            raise RuntimeError("Malformed open approval PR")
        repository = head.get("repo")
        if ("repo" not in head or (repository is not None and
                (not isinstance(repository, dict) or
                 not isinstance(repository.get("full_name"), str) or
                 not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository["full_name"])))):
            raise RuntimeError("Malformed approval head repository")
        numbers.add(pr["number"])
    return prs


def managed_branches(api):
    branches = list(api.items("branches"))
    names = set()
    for branch in branches:
        if (not isinstance(branch, dict) or not isinstance(branch.get("name"), str) or
                not branch["name"] or branch["name"] in names):
            raise RuntimeError("Malformed repository branch list")
        names.add(branch["name"])
    return {name for name in names if MANAGED_BRANCH.fullmatch(name)}


def delete_managed_branch(api, branch):
    if not MANAGED_BRANCH.fullmatch(branch):
        raise RuntimeError("Refusing to delete an unmanaged branch")
    try:
        api.request(f"git/refs/heads/{branch}", "DELETE")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return
        if error.code == 422:
            try:
                api.request(f"git/ref/heads/{branch}")
            except urllib.error.HTTPError as lookup_error:
                if lookup_error.code == 404:
                    return
                raise
        raise


def reconcile_prs(api, result):
    branches = managed_branches(api)
    managed = [pr for pr in open_page_prs(api)
               if MANAGED_BRANCH.fullmatch(pr["head"]["ref"]) and
               pr["head"]["repo"] and pr["head"]["repo"]["full_name"] == api.repository]
    current = next((pr for pr in managed if pr["head"]["ref"] == result["branch"]), None)
    if result["status"] != "unchanged":
        body = {"title": f"main {result['main_sha'][:7]} のPages公開を承認する", "body": pr_body(result)}
        if current:
            api.request(f"pulls/{current['number']}", "PATCH", body)
        else:
            current = api.request("pulls", "POST", {**body, "head": result["branch"], "base": "pages"})
        if (not isinstance(current, dict) or type(current.get("number")) is not int or
                current["number"] <= 0 or
                current.get("html_url") != f"https://github.com/{api.repository}/pull/{current['number']}"):
            raise RuntimeError("Malformed current approval PR")
    closed = set()
    for pr in managed:
        if result["status"] == "unchanged" or not current or pr["number"] != current["number"]:
            api.request(f"pulls/{pr['number']}", "PATCH", {"state": "closed"})
            closed.add(pr["head"]["ref"])
    protected = {pr["head"]["ref"] for pr in open_page_prs(api)}
    if result["status"] != "unchanged":
        protected.add(result["branch"])
    for branch in sorted((branches | closed) - protected):
        delete_managed_branch(api, branch)
    return current["html_url"] if current and result["status"] != "unchanged" else None


def publish(api, run_id, repo):
    run = api.request(f"actions/runs/{run_id}")
    if not full_build(api, run):
        return {"status": "skipped", "reason": "Not a complete successful main push build"}
    if not SHA.fullmatch(run["head_sha"]):
        raise RuntimeError("Invalid source main SHA")
    for newer in api.items("actions/workflows/build.yml/runs?branch=main&event=push&status=success", "workflow_runs"):
        if newer["run_number"] <= run["run_number"]:
            break
        if full_build(api, newer):
            artifact_for(api, newer)
            return {"status": "skipped", "reason": "A newer full main build has succeeded"}
    artifact = artifact_for(api, run)
    with tempfile.TemporaryDirectory(prefix="pages-artifact-", dir=repo.parent) as temporary:
        root = Path(temporary)
        archive = root / "artifact.zip"
        with archive.open("wb") as output:
            subprocess.run(["gh", "api", f"repos/{api.repository}/actions/artifacts/{artifact['id']}/zip"],
                           stdout=output, check=True)
        source = root / "public_html"
        source.mkdir()
        extract_archive(archive, source, artifact["digest"])
        init_repo(repo)
        remote = f"https://github.com/{api.repository}.git"
        if "origin" not in git(repo, "remote").splitlines():
            git(repo, "remote", "add", "origin", remote)
        elif git(repo, "remote", "get-url", "origin") != remote:
            raise RuntimeError("Unexpected delivery repository origin")
        token = base64.b64encode(f"x-access-token:{api.token}".encode()).decode()
        auth = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                "GIT_CONFIG_VALUE_0": f"AUTHORIZATION: basic {token}"}
        branch = f"pages-update/{run['head_sha']}"
        refs = git(repo, "ls-remote", "--heads", "origin", "pages", branch, env=auth)
        for line in refs.splitlines():
            _, ref = line.split("\t")
            if ref not in ("refs/heads/pages", f"refs/heads/{branch}"):
                raise RuntimeError("Unexpected remote ref")
            git(repo, "fetch", "--no-tags", "origin", f"{ref}:{ref}", env=auth)
        result = prepare(repo, source, run["head_sha"],
                         f"https://github.com/{api.repository}/actions/runs/{run_id}",
                         source_commit_date(api, run["head_sha"]))
        if result["bootstrap_created"]:
            git(repo, "push", "origin", "refs/heads/pages:refs/heads/pages", env=auth)
        if result["status"] != "unchanged":
            git(repo, "push", "origin", f"refs/heads/{branch}:refs/heads/{branch}", env=auth)
        result["pull_request"] = reconcile_prs(api, result)
        return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--git-repo", type=Path, required=True)
    parser.add_argument("--repository")
    parser.add_argument("--run-id", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--sha")
    parser.add_argument("--run-url")
    parser.add_argument("--commit-date")
    args = parser.parse_args()
    repo = args.git_repo.resolve()
    if not repo.parent.is_dir():
        parser.error("The Git directory parent must already exist")
    if args.dry_run:
        if not (args.source and args.sha and args.run_url and args.commit_date):
            parser.error("--dry-run requires --source, --sha, --run-url and --commit-date")
        result = prepare(repo, args.source.resolve(), args.sha, args.run_url, args.commit_date)
        result["dry_run"] = True
        result["pull_request"] = None
    else:
        if (not (args.repository and args.run_id and args.run_id > 0) or
                args.source or args.sha or args.run_url or args.commit_date):
            parser.error("Publishing requires only --repository, --run-id and --git-repo")
        result = publish(GitHub(args.repository), args.run_id, repo)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.CalledProcessError,
            zipfile.BadZipFile) as error:
        print(f"publish-pages: {error}", file=sys.stderr)
        raise SystemExit(1) from error
