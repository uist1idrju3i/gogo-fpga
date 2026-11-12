import copy
import csv
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("formal_audit", ROOT / "scripts/audit-formal-python.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class FormalAuditTest(unittest.TestCase):
    def write(self, name, value):
        target = self.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value if isinstance(value, bytes) else json.dumps(value).encode())

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)
        sha = AUDIT.digest(b"binary")
        script = "scripts/probe-formal-python-engine.mjs"
        self.meta = {"format": 1, "preliminary": True, "baseCommit": "1" * 40, "node": "unit", "python": "unit", "pyodide": "unit",
                     "snapshots": {script: AUDIT.digest(b"script")}, "scriptSha256": AUDIT.digest(b"script"),
                     "sources": {"assets": [{"path": "source.py", "size": 4, "sha256": AUDIT.digest(b"pass")}]}, "models": {}, "probes": {}}
        self.write("snapshots/" + script, b"script")
        self.write("assets/source.py", b"pass")
        self.write("assets/manifest.json", self.meta["sources"])
        self.rows = []
        for solver in ["yices2", "z3"]:
            for runtime in ["native", "wasi"]:
                label = solver + "-" + runtime
                build = {"status": "built", "worktree_status": "", "artifact": {"sha256": sha}, "source": {"version": "1.0"}}
                self.write(label + "-build.json", build)
                self.write(label + "-version.log", b"fixture 1.0\n")
                self.meta["probes"][label] = {"metadataSha256": AUDIT.digest((self.out / (label + "-build.json")).read_bytes()),
                                              "binarySha256": sha, "version": "fixture 1.0\n"}
            for case, phases in AUDIT.CASES.items():
                for phase in phases:
                    label = "-".join([solver, case, phase])
                    expected = int(case in ["bmc-violation", "cover-unreached"] or (case == "prove-inconclusive" and phase == "induction"))
                    stdout = b"## 0:00:00 Status: " + (b"FAILED" if expected else b"PASSED") + b"\n"
                    child = {"status": "exited", "exitCode": 0, "integrityVerified": True, "sha256": sha}
                    self.write(label + "/native.json", {"elapsedMs": 1.25, "exitCode": expected, "signal": None, "error": None})
                    self.write(label + "/transport.json", {"status": "exited", "exitCode": expected, "integrityVerified": True, "elapsedMs": 2.5, "children": [child]})
                    for runtime in ["native", "pyodide"]:
                        self.write(label + "/" + runtime + ".stdout.log", stdout)
                        self.write(label + "/" + runtime + ".stderr.log", b"")
                    names = ["model.smt2", "top.v"]
                    if case in ["bmc-violation", "cover-reached"] or (case == "prove-inconclusive" and phase == "induction"):
                        names += ["trace.vcd", "trace.yw", "trace_tb.v"]
                    for name in names:
                        self.write(label + "/native/" + name, name.encode())
                        self.write(label + "/pyodide-" + name, name.encode())
                    self.meta["models"][solver + "-" + case] = AUDIT.digest(b"model.smt2")
                    row = {"solver": solver, "case": case, "phase": phase, "nativeElapsedMs": 1.25, "pyodideElapsedMs": 2.5,
                           "nativeExitCode": expected, "pyodideExitCode": expected, "status": "exited", "children": [child],
                           "modelSha256": AUDIT.digest(b"model.smt2"), "solverSha256": sha,
                           "nativeStdoutSha256": AUDIT.digest(stdout), "pyodideStdoutSha256": AUDIT.digest(stdout),
                           "files": [{"path": n, "bytes": len(n), "sha256": AUDIT.digest(n.encode())} for n in names]}
                    self.rows.append(row)
                    self.write(label + "/result.json", row)
        self.write("metadata-final.json", self.meta)
        self.write("metadata.json", {**copy.deepcopy(self.meta), "models": {}, "probes": {}})
        self.write("results.json", {"preliminary": True, "rows": self.rows})
        self.csv_rows = [{key: AUDIT.cell(r.get(key)) for key in AUDIT.COLUMNS} for r in self.rows]
        self.save_csv()

    def save_csv(self):
        with (self.out / "results.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=AUDIT.COLUMNS)
            writer.writeheader()
            writer.writerows(self.csv_rows)

    def test_complete_matrix(self):
        self.assertEqual(AUDIT.audit(self.out), {"status": "pass", "preliminary": True, "commit": "1" * 40, "rows": 16, "columns": 13})

    def test_each_csv_column_rejects_an_altered_cell(self):
        for column in AUDIT.COLUMNS:
            with self.subTest(column=column):
                old = self.csv_rows[0][column]
                self.csv_rows[0][column] = "corrupt"
                self.save_csv()
                with self.assertRaises(ValueError):
                    AUDIT.audit(self.out)
                self.csv_rows[0][column] = old
        self.save_csv()
        self.assertEqual(AUDIT.audit(self.out)["status"], "pass")

    def test_missing_and_modified_artifacts_are_not_hidden_by_successful_status(self):
        file = self.out / "yices2-bmc-violation-bmc/pyodide-trace.vcd"
        original = file.read_bytes()
        for mutation in [None, b"changed"]:
            if mutation is None:
                file.unlink()
            else:
                file.write_bytes(mutation)
            with self.assertRaises((ValueError, OSError)):
                AUDIT.audit(self.out)
            file.write_bytes(original)

    def test_solver_crash_native_signal_stderr_and_row_duplicates_fail_closed(self):
        for name, key, value in [("transport.json", "status", "runtime-error"), ("native.json", "signal", "SIGKILL")]:
            file = self.out / "yices2-bmc-prefix-bmc" / name
            original = file.read_bytes()
            data = json.loads(original)
            data[key] = value
            self.write(file.relative_to(self.out), data)
            with self.assertRaises(ValueError):
                AUDIT.audit(self.out)
            file.write_bytes(original)
        self.write("yices2-bmc-prefix-bmc/pyodide.stderr.log", b"unexpected stderr")
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)
        self.write("yices2-bmc-prefix-bmc/pyodide.stderr.log", b"")
        self.csv_rows[1] = self.csv_rows[0]
        self.save_csv()
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)


if __name__ == "__main__":
    unittest.main()
