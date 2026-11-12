import copy
import csv
import importlib.util
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("audit", ROOT / "scripts/audit-solver-protocol.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class AuditTest(unittest.TestCase):
    def write_json(self, name, value):
        (self.out / name).write_text(json.dumps(value), encoding="utf-8")

    def csv_rows(self, rows):
        with (self.out / "results.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=AUDIT.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        self.end["csvSha256"] = AUDIT.digest((self.out / "results.csv").read_bytes())
        self.end["rows"] = len(rows)
        self.write_json("metadata-end.json", self.end)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        sha = AUDIT.digest(b"fixture")
        sources = {name: sha for name in AUDIT.REQUIRED_SOURCES}
        for name in sources:
            (self.out / name.replace("/", "__")).write_bytes(b"fixture")
        self.write_json("probes-manifest.json", {"yices2": {"native": "fixture-native", "wasi": "fixture-wasi"}})
        self.start = {"format": 2, "preliminary": True, "repeats": 1, "aa": 0, "harnessCommit": "1" * 40,
                      "worktreeStatus": "fixture", "sources": sources, "startedUnix": 1, "node": "fixture", "v8": "fixture",
                      "timeVersion": "fixture", "host": {"os": "fixture"}, "submodules": "fixture",
                      "manifestSha256": AUDIT.digest((self.out / "probes-manifest.json").read_bytes()), "probes": {}}
        self.write_json("metadata-start.json", self.start)
        self.end = {**copy.deepcopy(self.start), "endedUnix": 2, "status": "pass", "errors": []}
        for runtime in ["native", "wasi"]:
            info = {"solver": "yices2", "runtime": runtime, "status": "built", "worktree_status": "", "base_commit": "2" * 40,
                    "source": {"commit": "3" * 40, "version": "fixture"}, "script_sha256": sha, "patches": [],
                    "artifact": {"sha256": ("4" if runtime == "native" else "5") * 64, "bytes": 16, "path": "fixture"},
                    "compiler": "fixture", "commands": [{"label": c, "exit_status": 0, "log_sha256": sha} for c in ["configure", "build"]],
                    "gmp": {"archive_sha256": "6" * 64}, "wasi_sdk": {"archive_sha256": "7" * 64} if runtime == "wasi" else None}
            label = "yices2-" + runtime
            self.write_json(label + ".metadata.json", info)
            for command in info["commands"]:
                (self.out / f'{label}.{command["label"]}.log').write_bytes(b"fixture")
            self.end["probes"][label] = {**info, "actualVersion": "fixture",
                "metadataSha256": AUDIT.digest((self.out / (label + ".metadata.json")).read_bytes())}
        self.rows, controls = [], []
        for case in AUDIT.NORMAL + AUDIT.WORKER + AUDIT.SPECIAL["yices2"]:
            for runtime in ["native", "wasi"] if case in AUDIT.NORMAL else ["wasi"]:
                label = f"preliminary-1-yices2-{runtime}-{case}"
                probe = self.end["probes"]["yices2-" + runtime]
                frames = ["sat"]
                if case in ["incremental-bv", "incremental-array", "stale"]:
                    frames = ["sat", "((x #b0001))", "unsat", "sat", "(define-fun x () (_ BitVec 4) #b0001)"]
                elif case == "long-value":
                    frames = ["sat", "((big\n  #b" + "0" * 32767 + "1))"]
                elif case == "malformed":
                    frames = ['(error "fixture")']
                elif case in ["missing-response", "hash-mismatch", "corrupt-wasm", "worker-crash", "unsupported-alarm"]:
                    frames = []
                status = {"timeout": "timeout", "busy-timeout": "timeout", "cancel": "cancelled", "busy-cancel": "cancelled", "hash-mismatch": "integrity-error",
                          "corrupt-wasm": "invalid-wasm", "worker-crash": "crashed", "missing-termination": "timeout", "output-limit": "output-limit"}.get(case, "exited")
                rec = {"case": case, "status": status, "exitCode": (19 if case == "unsupported-alarm" else 0) if status == "exited" else None,
                       "signal": None, "verdict": "pass", "failure": None, "elapsedMs": 10.5, "framingError": None,
                       "executed": case not in ["hash-mismatch", "corrupt-wasm", "worker-crash"], "nativeMaxRssKiB": 1024 if runtime == "native" else None,
                       "memoryBytes": 65536 if runtime == "wasi" and status == "exited" else None,
                       "transmittedSha256": "0" * 64 if case == "hash-mismatch" else "9" * 64 if case == "corrupt-wasm" else probe["artifact"]["sha256"]}
                if runtime == "wasi":
                    rec["integrityVerified"] = status == "exited" or case == "corrupt-wasm"
                row = dict.fromkeys(AUDIT.COLUMNS, "")
                row.update(phase="preliminary", repeat="1", solver="yices2", runtime=runtime, case=case, elapsed_ms="10.5",
                           binary_sha256=probe["artifact"]["sha256"], source_commit=probe["source"]["commit"], binary_build_commit=probe["base_commit"],
                           harness_commit=self.end["harnessCommit"], script_sha256=sha, patches_sha256=AUDIT.digest(b"[]"), gmp_archive_sha256="6" * 64,
                           sdk_archive_sha256="7" * 64 if runtime == "wasi" else "", metadata_sha256=probe["metadataSha256"])
                for column, key in {"verdict": "verdict", "executed": "executed", "status": "status", "exit_code": "exitCode", "signal": "signal",
                                    "native_max_rss_kib": "nativeMaxRssKiB", "wasm_memory_bytes": "memoryBytes", "integrity_verified": "integrityVerified",
                                    "transmitted_sha256": "transmittedSha256", "failure": "failure"}.items():
                    row[column] = AUDIT.cell(rec.get(key))
                for channel, blob in [("stdout", ("\n".join(frames) + "\n" if frames else "").encode()),
                                      ("stderr", b"WASI alarms are unsupported; use a host worker deadline\n" if case == "unsupported-alarm" else b""),
                                      ("frames", AUDIT.compact(frames))]:
                    (self.out / (label + (".frames.json" if channel == "frames" else "." + channel))).write_bytes(blob)
                    rec[channel + "Sha256"] = AUDIT.digest(blob)
                    row[channel + "_sha256"] = AUDIT.digest(blob)
                    row["frame_count" if channel == "frames" else channel + "_bytes"] = str(len(frames) if channel == "frames" else len(blob))
                if runtime == "native":
                    (self.out / (label + ".rss")).write_text("1024\n")
                self.write_json(label + ".json", rec)
                self.rows.append(row)
                if runtime == "wasi" and case in ["incremental-bv", "incremental-array", "long-value"]:
                    controls.append({"phase": "preliminary", "repeat": 1, "solver": "yices2", "case": case, "derivedFrom": label,
                                     "checks": [{"control": name, "detected": True} for name in AUDIT.CONTROLS]})
        self.write_json("controls.json", controls)
        self.csv_rows(self.rows)

    def test_complete_matrix_and_nullable_resource_distributions(self):
        report = AUDIT.audit(self.out, preliminary=True)
        self.assertEqual((report["rows"], report["columns"], report["negativeControls"]), (21, 31, 21))
        missing = report["resources"]["preliminary/yices2/wasi/busy-timeout"]["wasm_memory_bytes"]
        self.assertEqual(missing, {"count": 0, "missing": 1, "min": None, "median": None, "max": None})
        self.assertRaises(ValueError, AUDIT.audit, self.out)

    def test_every_csv_column_has_an_independent_check(self):
        for column in AUDIT.COLUMNS:
            with self.subTest(column=column):
                rows = copy.deepcopy(self.rows)
                rows[0][column] += "changed"
                self.csv_rows(rows)
                self.assertRaises(ValueError, AUDIT.audit, self.out, True)

    def test_missing_or_duplicated_rows_cannot_be_hidden_by_rehashing(self):
        for rows in [self.rows[1:], self.rows + [self.rows[0]]]:
            self.csv_rows(rows)
            self.assertRaises(ValueError, AUDIT.audit, self.out, True)

    def test_boolean_is_not_an_elapsed_time(self):
        name = "preliminary-1-yices2-native-incremental-bv.json"
        rec = json.loads((self.out / name).read_text())
        rec["elapsedMs"] = True
        self.write_json(name, rec)
        self.rows[0]["elapsed_ms"] = "1"
        self.csv_rows(self.rows)
        self.assertRaisesRegex(ValueError, "elapsed time", AUDIT.audit, self.out, True)

    def test_invalid_git_object_is_rejected_before_running_git(self):
        self.end["harnessCommit"] = "--output=unexpected"
        self.write_json("metadata-end.json", self.end)
        with patch.object(AUDIT.subprocess, "check_output") as git:
            self.assertRaisesRegex(ValueError, "invalid harness commit", AUDIT.audit, self.out, True)
            git.assert_not_called()

    def test_wrong_classification_rejected_after_updating_record_and_csv(self):
        name = "preliminary-1-yices2-native-incremental-bv.json"
        rec = json.loads((self.out / name).read_text())
        rec["status"] = "timeout"
        self.write_json(name, rec)
        self.rows[0]["status"] = "timeout"
        self.csv_rows(self.rows)
        self.assertRaisesRegex(ValueError, "termination classification", AUDIT.audit, self.out, True)

    def test_zero_does_not_replace_missing_memory(self):
        index = next(i for i, r in enumerate(self.rows) if r["case"] == "busy-timeout")
        name = "preliminary-1-yices2-wasi-busy-timeout.json"
        rec = json.loads((self.out / name).read_text())
        rec["memoryBytes"] = 0
        self.write_json(name, rec)
        self.rows[index]["wasm_memory_bytes"] = "0"
        self.csv_rows(self.rows)
        self.assertRaisesRegex(ValueError, "invalid resource metric", AUDIT.audit, self.out, True)

    def test_missing_raw_build_evidence_fails(self):
        (self.out / "yices2-wasi.metadata.json").unlink()
        self.assertRaises(FileNotFoundError, AUDIT.audit, self.out, True)

    def format_three(self):
        for info in [self.start, self.end]:
            info["format"] = 3
        for label in self.end["probes"]:
            (self.out / (label + ".build-script.py")).write_bytes(b"fixture")
        self.write_json("metadata-start.json", self.start)
        self.write_json("metadata-end.json", self.end)

    def test_format_three_keeps_distinct_build_and_measurement_scripts(self):
        self.format_three()
        name = "scripts/build-solver-probe.py"
        (self.out / name.replace("/", "__")).write_bytes(b"new builder")
        for info in [self.start, self.end]:
            info["sources"][name] = AUDIT.digest(b"new builder")
        self.write_json("metadata-start.json", self.start)
        self.write_json("metadata-end.json", self.end)
        AUDIT.audit(self.out, True)

    def test_format_three_altered_build_script_snapshot_fails(self):
        self.format_three()
        (self.out / "yices2-wasi.build-script.py").write_bytes(b"altered")
        self.assertRaisesRegex(ValueError, "build script snapshot hash", AUDIT.audit, self.out, True)

    def test_format_three_missing_build_script_snapshot_fails(self):
        self.format_three()
        (self.out / "yices2-wasi.build-script.py").unlink()
        self.assertRaises(FileNotFoundError, AUDIT.audit, self.out, True)

    def test_altered_raw_build_log_fails(self):
        (self.out / "yices2-wasi.build.log").write_bytes(b"altered")
        self.assertRaisesRegex(ValueError, "raw build log hash", AUDIT.audit, self.out, True)

    def test_successful_status_cannot_hide_failed_build_command(self):
        label = "yices2-wasi"
        info = json.loads((self.out / (label + ".metadata.json")).read_text())
        info["commands"][0]["exit_status"] = 1
        self.write_json(label + ".metadata.json", info)
        self.end["probes"][label].update(info)
        self.end["probes"][label]["metadataSha256"] = AUDIT.digest((self.out / (label + ".metadata.json")).read_bytes())
        self.write_json("metadata-end.json", self.end)
        self.assertRaisesRegex(ValueError, "unsuccessful build command", AUDIT.audit, self.out, True)

    def test_undetected_control_fails(self):
        controls = json.loads((self.out / "controls.json").read_text())
        controls[0]["checks"][0]["detected"] = False
        self.write_json("controls.json", controls)
        self.assertRaisesRegex(ValueError, "undetected negative control", AUDIT.audit, self.out, True)

    def test_missing_harness_snapshot_fails_even_with_consistent_metadata(self):
        for info in [self.start, self.end]:
            del info["sources"]["web/lib/byte-pipe.mjs"]
        self.write_json("metadata-start.json", self.start)
        self.write_json("metadata-end.json", self.end)
        self.assertRaisesRegex(ValueError, "missing harness source", AUDIT.audit, self.out, True)


if __name__ == "__main__":
    unittest.main()
