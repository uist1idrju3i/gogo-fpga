import copy
import importlib.util
import json
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("smt_replay_audit", Path(__file__).resolve().parents[2] / "scripts/audit-smt-replay.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class SmtReplayAuditTest(unittest.TestCase):
    def test_replay_execution_and_verification_reject_boolean_integers_and_wrong_diagnostic_time(self):
        class MemoryEvidence:
            def read(self, name):
                return self.files[name]

            def data(self, name):
                return json.loads(self.read(name))

        evidence = MemoryEvidence()
        prefix = "replay-wasm/"
        stdout = ("FORMAL_REPLAY_DRIVE 1\nERROR: top.v:3: \n       Time: 0  Scope: __formal_replay.dut\n"
                  "FORMAL_REPLAY_CHECK 1\nFORMAL_REPLAY_DONE\n").encode()
        evidence.files = {
            prefix + "execution.json": b'{"status":0,"elapsedMs":1}',
            prefix + "verification.json": b'{"status":"verified","steps":1,"failures":[{"id":"P","step":1,"source":"top.v:3.1-3.9"}]}',
            prefix + "stdout.log": stdout,
            prefix + "stderr.log": b"",
            prefix + "replay.vcd": self.waveform().replace(b"#2000\n1!\nb1 #\n#3000\n0!\n#4000", b"#1000"),
        }
        plan = {"steps": 1, "endTimeNs": 1, "clock": None, "edge": "posedge", "content": "read-only replay",
                "locations": [{"id": "P", "kind": "assert", "path": "top.v", "line": 3, "source": "top.v:3.1-3.9"}]}
        signals = {"q": {"clock": None}}
        values = {"q": ["000"]}

        def audit():
            return AUDIT.replay_result(evidence, prefix, plan, signals, values, [])

        self.assertEqual(audit()["actual"], "verified")
        controls = [
            ("execution.json", lambda raw: raw.replace(b'"status":0', b'"status":false')),
            ("verification.json", lambda raw: raw.replace(b'"steps":1', b'"steps":true')),
            ("stdout.log", lambda raw: raw.replace(b"Time: 0", b"Time: 2000")),
        ]
        for name, modify in controls:
            original = evidence.files[prefix + name]
            evidence.files[prefix + name] = modify(original)
            with self.subTest(name=name), self.assertRaises(ValueError):
                audit()
            evidence.files[prefix + name] = original

    def waveform(self):
        return b"""$timescale 1ps $end
$scope module __formal_replay $end
$scope module dut $end
$var wire 1 ! clk $end
$var reg 3 # q [2:0] $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
b0 #
$end
#2000
1!
b1 #
#3000
0!
#4000
"""

    def test_waveform_observations_expand_vectors_without_discarding_clock_timing(self):
        value, end, times, states, names = AUDIT.waveform(self.waveform())
        self.assertEqual(end, 4)
        self.assertEqual(times, [0, 2000, 3000, 4000])
        self.assertEqual(value(["__formal_replay", "dut", "q"], 1), "000")
        self.assertEqual(value(["__formal_replay", "dut", "q"], 4), "001")
        self.assertEqual(value(["__formal_replay", "dut", "clk"], 2), "1")
        self.assertEqual(value(["__formal_replay", "dut", "clk"], 3), "0")
        with self.assertRaises(ValueError):
            value(["__formal_replay", "dut", "missing"], 1)
        with self.assertRaises(ValueError):
            value(["__formal_replay", "dut", "q"], 5)

    def test_waveform_parser_fails_on_missing_unknown_duplicate_or_malformed_data(self):
        mutations = [
            lambda raw: raw.replace(b"$timescale 1ps $end", b""),
            lambda raw: raw.replace(b"#0", b"#1"),
            lambda raw: raw.replace(b"#3000", b"#2000"),
            lambda raw: raw.replace(b"b1 #", b"b1111 #"),
            lambda raw: raw.replace(b"b1 #", b"b? #"),
            lambda raw: raw.replace(b"b1 #", b"b1 missing"),
            lambda raw: raw.replace(b"$upscope $end", b"", 1),
            lambda raw: raw.replace(b"$var reg 3 # q [2:0] $end", b"$var reg 3 # q [2:0] $end\n$var reg 3 $ q [2:0] $end"),
        ]
        for modify in mutations:
            with self.subTest(modify=modify), self.assertRaises((ValueError, KeyError)):
                AUDIT.waveform(modify(self.waveform()))

    def test_only_PI_order_is_benign_in_the_independent_comparator(self):
        first = "  reg [0:0] PI_z;\n  reg [0:0] PI_a;\n  top UUT (\n    .z(PI_z),\n    .a(PI_a)\n  );\n"
        other = "  reg [0:0] PI_a;\n  reg [0:0] PI_z;\n  top UUT (\n    .a(PI_a),\n    .z(PI_z)\n  );\n"
        self.assertEqual(AUDIT.normalize_tb(first), AUDIT.normalize_tb(other))
        for changed in [other.replace(".a(PI_a)", ".a(PI_z)"), other.replace("[0:0]", "[1:0]", 1), other + "assign clock = 0;\n"]:
            self.assertNotEqual(AUDIT.normalize_tb(first), AUDIT.normalize_tb(changed))

    def test_unconstrained_unknown_and_unsupported_state_cannot_qualify(self):
        module = {"netnames": {"q": {"bits": [1], "attributes": {"init": "0"}}},
                  "cells": {"r": {"type": "$dff", "connections": {"Q": [1]}}}}
        self.assertEqual(AUDIT.initialized_state(module), {1: "0"})
        for value in ["x", "z", "00", None, True]:
            changed = copy.deepcopy(module)
            changed["netnames"]["q"]["attributes"]["init"] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                AUDIT.initialized_state(changed)
        for cell_type in ["$mem_v2", "$memwr_v2", "$anyinit", "$dlatch"]:
            changed = copy.deepcopy(module)
            changed["cells"]["r"]["type"] = cell_type
            with self.subTest(cell_type=cell_type), self.assertRaises(ValueError):
                AUDIT.initialized_state(changed)
        changed = copy.deepcopy(module)
        del changed["netnames"]["q"]["attributes"]["init"]
        with self.assertRaises(ValueError):
            AUDIT.initialized_state(changed)


if __name__ == "__main__":
    unittest.main()
