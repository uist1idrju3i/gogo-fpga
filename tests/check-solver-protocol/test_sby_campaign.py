import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import test_sby_audit as fixtures


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("sby_measure", ROOT / "scripts/measure-formal-sby.py")
MEASURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MEASURE)


class SbyCampaignTest(unittest.TestCase):
    def setUp(self):
        fixture = fixtures.SbyAuditTest("test_complete_matrix_and_all_artifacts")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        base = fixture.out
        runner = b"runner"
        (base / "snapshots/scripts/measure-formal-sby.py").write_bytes(runner)
        native = json.loads((base / "native-metadata.json").read_bytes())
        native["preliminary"] = False
        fixture.write("native-metadata.json", native)
        for name in ["metadata.json", "metadata-final.json", "results.json"]:
            value = json.loads((base / name).read_bytes())
            value["preliminary"] = False
            if name.startswith("metadata"):
                value["snapshots"]["scripts/measure-formal-sby.py"] = MEASURE.AUDIT.digest(runner)
                value["nativeMetadataSha256"] = MEASURE.AUDIT.digest((base / "native-metadata.json").read_bytes())
            fixture.write(name, value)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        for phase, iteration in MEASURE.SCHEDULE:
            shutil.copytree(base, self.out / f"{phase}-{iteration}/runtime")
        MEASURE.json_file(self.out / "plan.json", {"format": 1, "worktree": "", "schedule": MEASURE.SCHEDULE,
            "commit": "1" * 40, "runnerSha256": MEASURE.AUDIT.digest(runner)})

    def test_complete_campaign_rederives_all_rows_and_statistics(self):
        rows, reports, summary = MEASURE.audit_campaign(self.out)
        self.assertEqual((len(rows), len(reports), summary["artifacts"], summary["columns"]), (84, 7, 1876, 19))
        self.assertEqual((summary["aaRows"], summary["formalRows"]), (24, 60))
        self.assertTrue(all(row["pyodide"] == {"minMs": 2.5, "medianMs": 2.5, "maxMs": 2.5} for row in summary["conditions"]))

    def test_missing_sample_mismatching_mode_and_dirty_plan_fail(self):
        for name, key, value in [("plan.json", "schedule", [["aa", True]] + MEASURE.SCHEDULE[1:]),
                                 ("plan.json", "worktree", " M source"),
                                 ("run-1/runtime/metadata-final.json", "preliminary", True),
                                 ("plan.json", "commit", "2" * 40),
                                 ("plan.json", "runnerSha256", "0" * 64)]:
            path = self.out / name
            original = path.read_bytes()
            data = json.loads(original)
            data[key] = value
            path.write_text(json.dumps(data))
            with self.subTest(name=name, key=key), self.assertRaises(ValueError):
                MEASURE.audit_campaign(self.out)
            path.write_bytes(original)
        shutil.rmtree(self.out / "run-5/runtime")
        with self.assertRaises(OSError):
            MEASURE.audit_campaign(self.out)

    def test_valid_but_different_pair_is_rejected_by_aa_comparison(self):
        run = self.out / "aa-2/runtime"
        label = "yices2-bmc-prefix"
        native = json.loads((run / label / "native.json").read_bytes())
        for runtime in ["native", "pyodide"]:
            for name in ["top.v", "result/src/top.v"]:
                path = run / label / runtime / name
                raw = path.read_bytes() + b"// changed input\n"
                path.write_bytes(raw)
                if runtime == "native":
                    native["files"][name] = {"bytes": len(raw), "sha256": MEASURE.AUDIT.digest(raw)}
        (run / label / "native.json").write_text(json.dumps(native))
        self.assertEqual(MEASURE.AUDIT.audit(run)["status"], "pass")
        with self.assertRaisesRegex(ValueError, "canonical artifacts differ"):
            MEASURE.audit_campaign(self.out)

    def test_saved_csv_and_summary_are_independently_checked(self):
        rows, _, summary = MEASURE.audit_campaign(self.out)
        raw = MEASURE.csv_bytes(rows)
        (self.out / "results.csv").write_bytes(raw)
        MEASURE.json_file(self.out / "summary.json", summary)
        self.assertEqual(MEASURE.audit_saved_campaign(self.out), summary)
        (self.out / "results.csv").write_bytes(raw.replace(b"aa,1,", b"aa,9,", 1))
        with self.assertRaisesRegex(ValueError, "campaign raw CSV"):
            MEASURE.audit_saved_campaign(self.out)
        (self.out / "results.csv").write_bytes(raw)
        summary["status"] = "skipped"
        (self.out / "summary.json").write_text(json.dumps(summary))
        with self.assertRaisesRegex(ValueError, "campaign summary"):
            MEASURE.audit_saved_campaign(self.out)
