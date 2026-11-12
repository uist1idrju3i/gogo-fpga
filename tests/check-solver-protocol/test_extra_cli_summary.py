import importlib.util
import json
from pathlib import Path
import shutil
import unittest
from unittest.mock import patch

import test_extra_cli_audit as fixture_module

SPEC = importlib.util.spec_from_file_location("cli_summary", fixture_module.ROOT / "scripts/summarize-extra-solver-cli.py")
SUMMARY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUMMARY)


class ExtraCliSummaryTest(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.ExtraCliAuditTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.prefix = self.fixture.root / "trial"
        self.output = self.fixture.root / "published"
        self.output.mkdir()
        for series, count in (("aa", 2), ("formal", 5)):
            for repetition in range(1, count + 1):
                shutil.copytree(self.fixture.directory, f"{self.prefix}-{series}-{repetition}")
        self.git = patch.object(SUMMARY.AUDIT.subprocess, "check_output", side_effect=self.fixture.git_output)
        self.git.start()
        self.addCleanup(self.git.stop)

    def test_generate_and_check_all_repetitions(self):
        result = SUMMARY.summarize(self.prefix, self.output)
        self.assertEqual(result["series"]["formal"]["rows"], 145)
        self.assertEqual(result["series"]["aa"]["rows"], 58)
        self.assertEqual(result["series"]["formal"]["columns"], 15)
        self.assertEqual(SUMMARY.summarize(self.prefix, self.output, check=True), result)

    def test_reject_missing_trial(self):
        shutil.rmtree(f"{self.prefix}-formal-5")
        with self.assertRaises(FileNotFoundError):
            SUMMARY.summarize(self.prefix, self.output)

    def test_reject_changed_published_column_and_label(self):
        SUMMARY.summarize(self.prefix, self.output)
        path = self.output / "S15-bitwuzla-cli-formal.csv"
        original = path.read_bytes()
        for before, after in ((b"formal-1", b"formal-9"), (b"runtime-error", b"exited"), (b"input_sha256", b"input_hash")):
            with self.subTest(column=before):
                path.write_bytes(original.replace(before, after))
                with self.assertRaises(ValueError):
                    SUMMARY.summarize(self.prefix, self.output, check=True)
        path.write_bytes(original)

    def test_reject_mixed_harness_commit(self):
        path = Path(f"{self.prefix}-formal-5") / "setup.json"
        setup = json.loads(path.read_bytes())
        setup["commit"] = "d" * 40
        path.write_text(json.dumps(setup))
        with self.assertRaises(ValueError):
            SUMMARY.summarize(self.prefix, self.output)
