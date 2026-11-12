import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[2] / "scripts/measure-extra-formal.py"
SPEC = importlib.util.spec_from_file_location("extra_campaign", SCRIPT)
CAMPAIGN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAMPAIGN)


class ExtraFormalCampaignTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.out = Path(self.temporary.name)
        snapshots = {name: CAMPAIGN.digest(SCRIPT.with_name(name).read_bytes()) for name in CAMPAIGN.SNAPSHOTS}
        self.write("plan.json", {"format": 1, "worktree": "", "commit": "1" * 40, "schedule": CAMPAIGN.SCHEDULE,
                                 "solvers": CAMPAIGN.SOLVERS, "runnerSha256": snapshots[SCRIPT.name], "snapshots": snapshots})
        for name in snapshots:
            path = self.out / "snapshots/scripts" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(SCRIPT.with_name(name).read_bytes())
        self.reports = {}
        for phase, iteration in CAMPAIGN.SCHEDULE:
            for solver in CAMPAIGN.SOLVERS:
                label = f"{phase}-{iteration}/{solver}/"
                self.reports[label.rstrip("/")] = {name: {"preliminary": False, "commit": "1" * 40, "conditions": [{"condition": solver + "-bmc-prefix", "canonicalSha256": "a" * 64}]} for name in CAMPAIGN.COLUMNS}
                for name, columns in CAMPAIGN.COLUMNS.items():
                    row = {key: "x" for key in columns if key not in ["series", "iteration", "nativeElapsedMs"]}
                    row.update(solver=solver, case="bmc-prefix", condition=solver + "-bounded-pass", phase="bmc", status="exited", error=None,
                               elapsedMs=1.25, nativeElapsedMs=2.25, pyodideElapsedMs=1.5, nativeExitCode=0, pyodideExitCode=0, files={})
                    if name == "smtbmc":
                        row.pop("error")
                    self.write(label + name + "/results.json", {"rows": [row]})
                    meta = {"snapshots": {"scripts/measure-extra-formal.py": snapshots[SCRIPT.name]}, "sources": {}, "probes": {},
                            "node": "unit", "pyodide" if name == "smtbmc" else "pyodidePackage": "unit",
                            "models": {}, "yosys": {"sha256": "2" * 64}}
                    self.write(label + name + ("/metadata.json" if name == "controls" else "/metadata-final.json"), meta)
                    if name != "controls":
                        self.write(label + name + "/native-metadata.json", {key: "unit" for key in ["python", "yosys", "sources", "pins"]})
                    if name == "sby":
                        self.write(label + name + "/" + solver + "-bmc-prefix/native.json", {"elapsedMs": 2.25})
        self.mock = patch.object(CAMPAIGN, "audit_pair", side_effect=lambda directory, *_: copy.deepcopy(self.reports[str(Path(directory).relative_to(self.out))]))
        self.mock.start()
        self.addCleanup(self.mock.stop)

    def write(self, path, value):
        target = self.out / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(value))

    def test_schedule_phase_columns_and_five_sample_statistics(self):
        summary = CAMPAIGN.audit_campaign(self.out, saved=False)
        self.assertEqual(CAMPAIGN.audit_campaign(self.out), summary)
        for name, table in summary["tables"].items():
            self.assertEqual((table["rows"], table["formalRows"], table["aaRows"]), (14, 10, 4))
            self.assertEqual(table["columns"], len(CAMPAIGN.COLUMNS[name]))
            self.assertTrue(all(item["samples"] == 5 for item in table["timings"]))
        import csv
        with (self.out / "smtbmc.csv").open() as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual({row["series"] for row in rows}, {"aa", "run"})
        self.assertEqual({row["phase"] for row in rows}, {"bmc"})
        self.assertEqual({row["error"] for row in rows}, {""})

    def test_smtbmc_blank_error_is_normalized_but_nonempty_error_is_rejected(self):
        path = "aa-1/bitwuzla/smtbmc/results.json"
        value = json.loads((self.out / path).read_bytes())
        value["rows"][0]["error"] = ""
        self.write(path, value)
        CAMPAIGN.audit_campaign(self.out, saved=False)
        value["rows"][0]["error"] = "runtime failure"
        self.write(path, value)
        with self.assertRaisesRegex(ValueError, "SMTBMC execution error"):
            CAMPAIGN.audit_campaign(self.out)

    def test_saved_campaign_rejects_modified_csv_summary_and_auditor(self):
        CAMPAIGN.audit_campaign(self.out, saved=False)
        for name in ["smtbmc.csv", "sby.csv", "controls.csv", "summary.json", "audits.json", "snapshots/scripts/formal-solver-audit.py"]:
            path = self.out / name
            raw = path.read_bytes()
            path.write_bytes(b"changed")
            with self.subTest(name=name), self.assertRaises((ValueError, json.JSONDecodeError)):
                CAMPAIGN.audit_campaign(self.out)
            path.write_bytes(raw)

    def test_each_real_metadata_runtime_key_is_required_and_drift_is_rejected(self):
        for name in CAMPAIGN.COLUMNS:
            path = self.out / "aa-2/bitwuzla" / name / ("metadata.json" if name == "controls" else "metadata-final.json")
            key = "pyodide" if name == "smtbmc" else "pyodidePackage"
            raw = path.read_bytes()
            value = json.loads(raw)
            self.assertIn(key, value)
            value[key] = "changed"
            path.write_text(json.dumps(value))
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "source, runtime"):
                CAMPAIGN.audit_campaign(self.out, saved=False)
            value.pop(key)
            path.write_text(json.dumps(value))
            with self.subTest(missing=name), self.assertRaises(KeyError):
                CAMPAIGN.audit_campaign(self.out, saved=False)
            path.write_bytes(raw)

    def test_runtime_and_canonical_drift_stop_campaign(self):
        names = ["aa-2/bitwuzla/smtbmc/metadata-final.json", "aa-2/bitwuzla/smtbmc/results.json", "aa-2/boolector/sby/native-metadata.json"]
        for name in names:
            path = self.out / name
            raw = path.read_bytes()
            data = json.loads(raw)
            if "results" in name:
                data["rows"][0]["modelSha256"] = "changed"
            elif "native" in name:
                data["python"] = "changed"
            else:
                data["probes"] = {"changed": True}
            self.write(name, data)
            with self.subTest(name=name), self.assertRaises(ValueError):
                CAMPAIGN.audit_campaign(self.out, saved=False)
            path.write_bytes(raw)
