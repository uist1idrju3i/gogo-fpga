import csv
import importlib.util
import io
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("trace_campaign", Path(__file__).resolve().parents[2] / "scripts/measure-formal-trace.py")
CAMPAIGN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAMPAIGN)


class FormalTraceCampaignTest(unittest.TestCase):
    def test_schedule_keeps_default_pair_and_every_explicit_solver(self):
        self.assertEqual(CAMPAIGN.SCHEDULE, [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)])
        self.assertEqual(CAMPAIGN.GROUPS, {"default": ("yices2", "z3"), "bitwuzla": ("bitwuzla",), "boolector": ("boolector",)})
        self.assertEqual(CAMPAIGN.COLUMNS, ["series", "iteration", *CAMPAIGN.AUDIT.COLUMNS])
        self.assertEqual(len(CAMPAIGN.COLUMNS), 19)

    def test_csv_preserves_empty_capture_hash_and_error_boolean_and_zero(self):
        row = dict.fromkeys(CAMPAIGN.COLUMNS, "value")
        row.update(series="aa", iteration=1, expectedTrace=False, exitCode=0, traceCount=0, captureSha256=None, error=None, elapsedMs=0.125)
        reader = csv.DictReader(io.StringIO(CAMPAIGN.csv_bytes([row]).decode()))
        self.assertEqual(reader.fieldnames, CAMPAIGN.COLUMNS)
        actual = list(reader)
        self.assertEqual(len(actual), 1)
        for name, expected in {"captureSha256": "", "error": "", "expectedTrace": "false", "exitCode": "0", "traceCount": "0", "elapsedMs": "0.125"}.items():
            self.assertEqual(actual[0][name], expected)
