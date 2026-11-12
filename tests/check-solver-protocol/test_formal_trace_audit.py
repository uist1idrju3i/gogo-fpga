import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("trace_audit", Path(__file__).resolve().parents[2] / "scripts/audit-formal-trace.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class FormalTraceAuditTest(unittest.TestCase):
    def test_launcher_name_and_upstream_native_artifact_are_distinct(self):
        probe = {"command": {"resolvedPath": "/build/source/static_bin/yices_smt2"},
                 "native": {"artifact": {"path": "source/static_bin/yices_smt2"}}}
        AUDIT.audit_resolved_native(probe)
        for path in ["yices-smt2", "/build/source/static_bin/yices-smt2", "/build/other/yices_smt2"]:
            changed = copy.deepcopy(probe)
            changed["command"]["resolvedPath"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                AUDIT.audit_resolved_native(changed)
        for path in ["../yices_smt2", "/source/static_bin/yices_smt2", "C:/yices_smt2", "source\\yices_smt2", "./source/static_bin/yices_smt2"]:
            changed = copy.deepcopy(probe)
            changed["native"]["artifact"]["path"] = path
            with self.subTest(path=path), self.assertRaises(ValueError):
                AUDIT.audit_resolved_native(changed)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.evidence = AUDIT.Evidence(self.root)
        stream = io.StringIO()
        writer = AUDIT.original_writer()(stream)
        writer.add_clock(["top", "clk"], "posedge")
        writer.add_net(["top", "q"], 1)
        self.steps = []
        for time in range(2):
            writer.set_time(time)
            writer.set_net(["top", "clk"], "0")
            writer.set_net(["top", "q"], str(time))
            self.steps.append({"time": time, "values": [{"path": ["top", "clk"], "bits": "0"}, {"path": ["top", "q"], "bits": str(time)}]})
        writer.set_time(2)
        raw = stream.getvalue().encode()
        (self.root / "trace.vcd").write_bytes(raw)
        self.trace = {"path": "trace.vcd", "sha256": AUDIT.digest(raw), "endTime": 2, "signals": [
            {"path": ["top", "clk"], "width": 1, "clock": "posedge"}, {"path": ["top", "q"], "width": 1, "clock": None}], "steps": self.steps}
        self.payload = {"format_version": 1, "upstreamExitCode": 1, "model": {"path": "model.smt2", "sha256": "1" * 64}, "traces": [self.trace]}

    def check(self, payload):
        (self.root / "formal-trace.json").write_text(json.dumps(payload))
        return AUDIT.capture(self.evidence, "", 1, "1" * 64, True)

    def test_capture_is_checked_against_original_vcd_bytes(self):
        sha, count = self.check(self.payload)
        self.assertEqual(count, 1)
        self.assertEqual(sha, AUDIT.digest((self.root / "formal-trace.json").read_bytes()))
        payload = copy.deepcopy(self.payload)
        payload["traces"][0]["steps"][0]["values"][1]["bits"] = "1"
        with self.assertRaisesRegex(ValueError, "disagree with original VCD"):
            self.check(payload)

    def test_each_capture_field_rejects_inconsistent_success(self):
        mutations = [
            ([], "format_version", True), ([], "upstreamExitCode", True), (["model"], "path", "../model.smt2"),
            (["model"], "sha256", "2" * 64), (["traces", 0], "path", "../trace.vcd"), (["traces", 0], "sha256", "2" * 64),
            (["traces", 0], "endTime", True), (["traces", 0], "endTime", 3), (["traces", 0], "steps", []),
            (["traces", 0, "signals", 0], "clock", "both"), (["traces", 0, "signals", 0], "width", 2),
            (["traces", 0, "signals", 1], "width", False), (["traces", 0, "signals", 1], "path", ["top", "clk"]),
            (["traces", 0, "steps", 0], "time", True), (["traces", 0, "steps", 1], "time", 3),
            (["traces", 0, "steps", 0], "values", []),
        ]
        for bits in ["x", "z", "?", "", "00", "2"]:
            mutations.append((["traces", 0, "steps", 0, "values", 1], "bits", bits))
        for path in [[], ["top", "missing"], ["top", "clk"], [None], ["\0"]]:
            mutations.append((["traces", 0, "steps", 0, "values", 1], "path", path))
        for path, key, value in mutations:
            payload = copy.deepcopy(self.payload)
            target = payload
            for part in path:
                target = target[part]
            target[key] = value
            with self.subTest(path=path, key=key, value=value), self.assertRaises((ValueError, KeyError, TypeError)):
                self.check(payload)

    def test_evidence_rejects_nonfinite_duplicate_json_and_unsafe_paths(self):
        for raw in ['{"n":NaN}', '{"n":Infinity}', '{"n":1e999}', '{"n":1,"n":2}', '{"n":{"a":1,"a":2}}']:
            (self.root / "bad.json").write_text(raw)
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                self.evidence.data("bad.json")
        for name in ["", ".", "..", "../a", "/a", "a/../b", "./a", "a//b", "C:a", "a\\b", "a\0b"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.evidence.path(name)
        (self.root / "link").symlink_to(self.root / "trace.vcd")
        with self.assertRaises(ValueError):
            self.evidence.path("link")
        (self.root / "dir").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            AUDIT.Evidence(self.root / "dir")
