import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / ".github/scripts/validate_release.sh"


class ValidateReleaseTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_AUTHOR_NAME": "Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "GITHUB_EVENT_NAME": "push",
            "GITHUB_REPOSITORY": "fixture/repo",
            "PATH": f"{self.root}{os.pathsep}{os.environ['PATH']}",
        }
        self.env.pop("RELEASE_TAG_PUBLIC_KEY", None)
        gh = self.root / "gh"
        gh.write_text(
            "#!/bin/sh\n"
            "case \"$*\" in\n"
            "  *deployment-branch-policies*)\n"
            "    echo '[{\"branch_policies\":[{\"type\":\"tag\",\"name\":\"v*\"}]}]' ;;\n"
            "  *environments/production)\n"
            "    echo '{\"can_admins_bypass\":false,\"deployment_branch_policy\":"
            "{\"protected_branches\":false,\"custom_branch_policies\":true},"
            "\"protection_rules\":[{\"type\":\"required_reviewers\",\"reviewers\":[{}]}]}' ;;\n"
            "  *) exit 1 ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        gh.chmod(0o755)
        self.git("init", "--quiet")
        self.git("commit", "--quiet", "--allow-empty", "-m", "main")
        self.commit = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/origin/main", self.commit)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, env=self.env, text=True).strip()

    def validate(self, tag, sha, **overrides):
        return subprocess.run(
            ["bash", str(SCRIPT)],
            cwd=self.root,
            env={
                **self.env,
                "GITHUB_REF": f"refs/tags/{tag}",
                "GITHUB_REF_NAME": tag,
                "GITHUB_SHA": sha,
                **overrides,
            },
            capture_output=True,
            text=True,
        )

    def test_unsigned_lightweight_and_annotated_tags(self):
        self.git("tag", "v1.0.0")
        self.git("tag", "-a", "-m", "fixture", "v1.0.1")
        for tag in ("v1.0.0", "v1.0.1"):
            with self.subTest(tag=tag):
                result = self.validate(tag, self.git("rev-parse", f"refs/tags/{tag}"))
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_ref_name_must_match(self):
        self.git("tag", "v1.0.0")
        result = self.validate("v1.0.0", self.commit, GITHUB_REF_NAME="v1.0.1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Tag name does not match the ref", result.stderr)

    def test_tag_must_be_in_main_history(self):
        self.git("commit", "--quiet", "--allow-empty", "-m", "off main")
        self.git("tag", "v1.0.0")
        result = self.validate("v1.0.0", self.git("rev-parse", "HEAD"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("The tagged commit must be in main history", result.stderr)
