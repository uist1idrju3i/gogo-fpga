import csv
import importlib.util
import io
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


CAMPAIGN = load("measure-smt-replay")
NEGATIVE = load("negative-smt-replay")
ARCHIVE = load("package-extra-formal")


class SmtReplayCampaignTest(unittest.TestCase):
    def test_schedule_interleaves_all_four_solvers_and_preserves_every_column(self):
        self.assertEqual(CAMPAIGN.SCHEDULE, [("aa", 1), ("aa", 2)] + [("run", n) for n in range(1, 6)])
        self.assertEqual(CAMPAIGN.SOLVERS, ("yices2", "z3", "bitwuzla", "boolector"))
        self.assertEqual(CAMPAIGN.COLUMNS, ["series", "iteration", *CAMPAIGN.AUDIT.COLUMNS])
        self.assertEqual(len(CAMPAIGN.COLUMNS), 23)
        self.assertEqual(ARCHIVE.campaign_sources({"kind": "smt-replay-v1"}), CAMPAIGN.SNAPSHOTS)

    def test_csv_roundtrip_preserves_null_zero_fraction_and_rejected_error(self):
        row = dict.fromkeys(CAMPAIGN.COLUMNS)
        row.update(series="aa", iteration=1, exitCode=0, elapsedMs=0.125, error="unsupported")
        reader = csv.DictReader(io.StringIO(CAMPAIGN.csv_bytes([row]).decode()))
        self.assertEqual(reader.fieldnames, CAMPAIGN.COLUMNS)
        actual = next(reader)
        for key, value in {"iteration": "1", "exitCode": "0", "elapsedMs": "0.125", "error": "unsupported", "vcdSha256": ""}.items():
            self.assertEqual(actual[key], value)

    def test_only_VCD_date_is_normalized_between_repeated_runs(self):
        raw = b"$date\nSunday\n$end\n$version\nIcarus\n$end\n#0\n0!\n"
        changed = raw.replace(b"Sunday", b"Monday")
        self.assertEqual(CAMPAIGN.normalized_vcd(raw), CAMPAIGN.normalized_vcd(changed))
        self.assertNotEqual(CAMPAIGN.normalized_vcd(raw), CAMPAIGN.normalized_vcd(raw.replace(b"0!", b"1!")))
        for invalid in [b"#0\n0!", raw + raw]:
            with self.assertRaises(ValueError):
                CAMPAIGN.normalized_vcd(invalid)

    def test_negative_controls_cover_both_formats_and_all_artifact_boundaries(self):
        mutations = NEGATIVE.mutations("yices2")
        controls = {label for label, name, modify in mutations}
        self.assertEqual(len(controls), len(mutations))
        self.assertEqual(len(controls), 79)
        for column in CAMPAIGN.AUDIT.COLUMNS:
            self.assertIn("csv-" + column, controls)
            self.assertIn("json-" + column, controls)
        for label in ["source", "model", "vcd", "testbench", "capture-value", "missing-sample", "clock-edge", "replay", "replay-output", "replay-exit"]:
            self.assertIn(label, controls)


if __name__ == "__main__":
    unittest.main()
