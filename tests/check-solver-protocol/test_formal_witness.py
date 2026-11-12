import csv
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tempfile
import unittest

import test_formal_controls


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("witness_audit", ROOT / "scripts/audit-formal-witness.py")
WITNESS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WITNESS)
SPEC_CAMPAIGN = importlib.util.spec_from_file_location("control_campaign", ROOT / "scripts/measure-formal-controls.py")
CAMPAIGN = importlib.util.module_from_spec(SPEC_CAMPAIGN)
SPEC_CAMPAIGN.loader.exec_module(CAMPAIGN)


class WitnessBoundaryTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        snapshots = {}
        for name in ["scripts/probe-formal-witness.mjs", "scripts/audit-formal-witness.py", "tests/synth/formal-witness-boundary.py",
                     "tests/synth/formal-control-workers.mjs", "tests/synth/formal-controlled-python-worker.mjs"]:
            self.raw("snapshots/" + name, b"snapshot")
            snapshots[name] = WITNESS.digest(b"snapshot")
        assets = []
        for name in ["sby.py", "witness.py", "ywio.py", "formal_process.py"]:
            self.raw("original-assets/" + name, b"source")
            assets.append({"path": name, "size": 6, "sha256": WITNESS.digest(b"source")})
        manifest = {"assets": assets, "pins": {"yosys": "a" * 40}}
        self.write("original-assets/manifest.json", manifest)
        runtime = json.loads(json.dumps(manifest))
        runtime["assets"][0].update(size=8, sha256=WITNESS.digest(b"snapshot"))
        runtime["test_fixture"] = "Root SbyPopen boundary fixture, not upstream SBY"
        self.write("runtime-manifest.json", runtime)
        self.raw("inputs/yosys", b"native")
        self.raw("native/design_prep.il", b"fixture")
        meta = {"format": 1, "purpose": "witness-format-boundary-only-not-an-SBY-proof", "preliminary": False,
                "commit": "a" * 40, "worktree": "", "snapshots": snapshots, "node": "fixture", "pyodidePackage": "fixture", "python": "fixture",
                "yosys": {"sha256": WITNESS.digest(b"native"), "version": "fixture aaaaaaaaa"}}
        self.write("metadata.json", meta)
        for name in ["aiger", "btor"]:
            self.raw("native/" + name + ".ys", b"script")
            self.write(f"native/{name}-process.json", {"args": ["-Q", "-T", "-s", name + ".ys"], "exitCode": 0, "signal": None,
                                                    "error": None, "scriptSha256": WITNESS.digest(b"script")})
            self.raw(f"native/{name}-stderr.log", b"")
        children, rows = [], []
        for conversion, trace, mapping, output in WITNESS.CASES:
            for name, raw in [(trace, b"fixture"), (mapping, b"map"),
                              (output, json.dumps({"format": "Yosys Witness Trace", "generator": "yosys-witness " + conversion, "steps": [{}, {}]}).encode())]:
                self.raw("native/" + name, raw)
                self.raw("output/witness/" + name, raw)
            args = [conversion, trace, mapping, output]
            children.append({"role": "tool", "args": ["yosys-witness", *args], "status": "exited", "integrityVerified": True, "exitCode": 0, "children": []})
            self.write("native/" + conversion + "-process.json", {"args": ["witness.py", *args], "exitCode": 0, "signal": None, "error": None})
            self.raw("native/" + conversion + "-stdout.log", b"Converted 2 time steps.\n")
            self.raw("native/" + conversion + "-stderr.log", b"")
            raw = (self.out / "native" / output).read_bytes()
            rows.append(dict(zip(WITNESS.COLUMNS, [conversion, "exited", 0, len(raw), WITNESS.digest(raw), WITNESS.digest(b"map"), 100])))
        self.write("transport.json", {"status": "exited", "integrityVerified": True, "exitCode": 0, "elapsedMs": 100, "children": children})
        self.raw("stdout.log", b"Converted 2 time steps.\n" * 2)
        self.raw("stderr.log", b"")
        workers, events = [], []
        for i in range(3):
            workers.append({"id": i, "kind": "python", "root": i == 0, "exited": True})
            events.extend([{"worker": i, "event": "start", "entrypoint": "sby" if i == 0 else "witness", "ms": 1},
                           {"worker": i, "event": "native-guards-installed", "resourceAvailable": False},
                           {"worker": i, "event": "exit", "ms": 2, "acknowledged": True, "expectedTermination": True, "code": 1}])
        self.write("workers.json", workers)
        self.write("events.json", events)
        self.write("results.json", {"preliminary": False, "rows": rows})
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=WITNESS.COLUMNS, quoting=csv.QUOTE_ALL, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        self.raw("results.csv", stream.getvalue().encode())

    def raw(self, name, raw):
        target = self.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)

    def write(self, name, value):
        self.raw(name, json.dumps(value).encode())

    def test_complete_two_converters(self):
        self.assertEqual(WITNESS.audit(self.out)["rows"], 2)

    def test_raw_mutations(self):
        for name, raw in [("output/witness/aiger.yw", b"tampered"), ("stdout.log", b"tampered"),
                          ("results.csv", b"tampered"), ("native/aiger-stderr.log", b"warning"),
                          ("snapshots/tests/synth/formal-witness-boundary.py", b"different")]:
            with self.subTest(name=name):
                original = (self.out / name).read_bytes()
                self.raw(name, raw)
                with self.assertRaises(ValueError):
                    WITNESS.audit(self.out)
                self.raw(name, original)

    def test_child_integrity_and_root_replacement(self):
        for name, change in [("transport.json", lambda d: d["children"][0].update(integrityVerified=False)),
                             ("runtime-manifest.json", lambda d: d["assets"][1].update(sha256="0" * 64)),
                             ("native/wit2yw-process.json", lambda d: d.update(exitCode=1)),
                             ("workers.json", lambda d: d[1].update(exited=False))]:
            with self.subTest(name=name):
                original = (self.out / name).read_bytes()
                data = json.loads(original)
                change(data)
                self.write(name, data)
                with self.assertRaises(ValueError):
                    WITNESS.audit(self.out)
                self.raw(name, original)


class ControlsCampaignTest(unittest.TestCase):
    def setUp(self):
        control = test_formal_controls.FormalControlsTest("test_complete_matrix")
        control.setUp()
        self.addCleanup(control.doCleanups)
        witness = WitnessBoundaryTest("test_complete_two_converters")
        witness.setUp()
        self.addCleanup(witness.doCleanups)
        data = json.loads((control.out / "metadata.json").read_bytes())
        data.update(node="fixture", pyodidePackage="fixture")
        control.write("metadata.json", data)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        for phase, iteration in CAMPAIGN.SCHEDULE:
            label = f"{phase}-{iteration}"
            shutil.copytree(control.out, self.out / label)
            shutil.copytree(witness.out, self.out / (label + "-witness"))
        (self.out / "plan.json").write_text(json.dumps({"commit": "a" * 40, "worktree": "", "schedule": CAMPAIGN.SCHEDULE}))

    def test_complete_campaign_and_raw_csv(self):
        summary = CAMPAIGN.audit_campaign(self.out)
        self.assertEqual((summary["rows"], summary["witnessRows"]), (161, 14))
        self.assertEqual(CAMPAIGN.audit_campaign(self.out), summary)
        (self.out / "witness-results.csv").write_bytes(b"changed")
        with self.assertRaises(ValueError):
            CAMPAIGN.audit_campaign(self.out)

    def test_repetition_identity_mismatch(self):
        target = self.out / "run-5/metadata.json"
        data = json.loads(target.read_bytes())
        data["node"] = "changed"
        target.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            CAMPAIGN.audit_campaign(self.out)
