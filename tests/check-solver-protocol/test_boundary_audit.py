import csv
import gzip
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("boundary_audit", ROOT / "scripts/audit-extra-solver-boundaries.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
COMMIT = "a" * 40
PIN = "b" * 40


class BoundaryAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "result"
        self.directory.mkdir()
        self.git = {
            "scripts/probe-extra-solver-boundaries.mjs": b"runner",
            "scripts/build-extra-solver-boundaries.py": b"probe-driver",
            "tests/synth/extra-solver-boundary.c": b"probe-harness",
            "scripts/build-solver-probe.py": b"solver-driver",
        }
        self.mock = patch.object(AUDIT.subprocess, "check_output", side_effect=self.git_read).start()
        self.addCleanup(patch.stopall)
        self.make_fixture()

    def git_read(self, argv, **_kwargs):
        if argv == ["git", "ls-tree", COMMIT, "vendor/boolector"]:
            return f"160000 commit {PIN}\tvendor/boolector\n".encode()
        self.assertEqual(argv[:2], ["git", "show"])
        commit, name = argv[2].split(":", 1)
        self.assertEqual(commit, COMMIT)
        return self.git[name]

    @staticmethod
    def save(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value) + "\n")

    @staticmethod
    def file(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {"path": path.name, "bytes": len(data), "sha256": AUDIT.sha(data)}

    def make_fixture(self, controls=False):
        rows = []
        cases = ("ids",) if controls else ("ids", "trace-plain", "trace-gzip")
        self.file(self.directory / "probe-extra-solver-boundaries.mjs", b"runner")
        settings = {"repository": str(self.root), "phase": "formal-probe", "worktree": "", "commit": COMMIT,
                    "script_sha256": AUDIT.sha(b"runner"), "unpatched_ids": controls,
                    "argv": ["node", "probe", "--native", "build/native", "--wasi", "build/wasi", "--out", "result"]}
        self.save(self.directory / "settings.json", settings)
        for runtime in ("native", "wasi"):
            directory = self.root / "build" / runtime
            source_dir = self.root / "build" / f"solver-{runtime}"
            primary = {"status": "built", "runtime": runtime, "solver": "boolector", "base_commit": COMMIT,
                       "worktree_status": "", "source": {"commit": PIN}, "script_sha256": AUDIT.sha(b"solver-driver"),
                       "script_snapshot": "build-solver-probe.py", "patches": [], "commands": [],
                       "dependencies": {"btor2tools": {"archive_sha256": AUDIT.sha(b"archive")}}, "static_libraries": {}}
            self.file(source_dir / primary["script_snapshot"], b"solver-driver")
            primary["artifact"] = self.file(source_dir / "objects/bin/boolector", b"solver-binary")
            primary["artifact"]["path"] = "objects/bin/boolector"
            for name in ("boolector", "cadical", "btor2parser"):
                primary["static_libraries"][name] = self.file(source_dir / f"{name}.a", name.encode())
            if runtime == "wasi":
                for index, name in enumerate(("cadical-wasi-cross", "cadical-wasi-pipes", "cadical-wasi-resources",
                                              "cadical-wasi-alarm", "btor2tools-wasi-ids", "boolector-wasi-trace")):
                    relative = f"patches/{name}.patch"
                    self.git[relative] = relative.encode()
                    item = self.file(source_dir / f"patch-{index}.patch", relative.encode())
                    primary["patches"].append({"path": relative, "snapshot": item["path"], "sha256": item["sha256"]})
            info = {"status": "built", "format": 1, "runtime": runtime, "base_commit": COMMIT, "unpatched_ids": controls,
                    "worktree_status": "", "script_sha256": AUDIT.sha(b"probe-driver"), "harness_sha256": AUDIT.sha(b"probe-harness"),
                    "source_build": str(source_dir), "source_build_commit": COMMIT, "patches": [], "commands": [], "artifacts": {}}
            for build, parent, status_key in ((primary, source_dir, "exit_status"), (info, directory, "exit_code")):
                log = self.file(parent / "compile.log", b"compile success")
                build["commands"] = [{"label": "compile", status_key: 0, "log_sha256": log["sha256"]}]
            self.save(source_dir / "metadata.json", primary)
            info["source_metadata_sha256"] = AUDIT.sha((source_dir / "metadata.json").read_bytes())
            self.file(directory / "build-extra-solver-boundaries.py", b"probe-driver")
            self.file(directory / "extra-solver-boundary.c", b"probe-harness")
            self.file(directory / "btor2tools-source.tar", b"archive")
            for name in ("ids", "trace"):
                info["artifacts"][name] = self.file(directory / name, f"{runtime}-{name}".encode())
            self.save(directory / "metadata.json", info)
            for case in cases:
                negative = runtime == "wasi" and controls
                blocked = runtime == "wasi" and case == "trace-gzip"
                input_bytes = b"1 sort bitvec 1\n2 input 1\n" if case == "ids" else b""
                if case == "ids":
                    selected = [id for id in AUDIT.IDS if not controls or abs(id) != 2147483648]
                    output = "".join(f"id={id} found={abs(id) if abs(id) in (1, 2) else 1 if negative and abs(id) in (4294967295, 4294967297, 9223372036854775807) else 0}\n" for id in selected).encode()
                    args = ["--alias-only"] if controls else []
                else:
                    mode, extension = ("gzip", "gz") if case == "trace-gzip" else ("plain", "txt")
                    args = [mode, str(self.directory / f"{case}.{extension}") if runtime == "native" else f"/tmp/boundary-trace.{extension}"]
                    output = b"trace-requested\n" if blocked else b"trace-requested\ntrace-opened\n"
                error = b"Boolector: gzip API traces are unavailable on WASI\n" if blocked else b""
                artifact = info["artifacts"]["ids" if case == "ids" else "trace"]
                result = {"status": "runtime-error" if blocked else "exited", "exitCode": None if blocked else 23 if negative else 0,
                          "signal": None, "integrityVerified": True, "error": "unreachable" if blocked else None,
                          "memoryBytes": None if runtime == "native" or blocked else 33554432,
                          "sha256": artifact["sha256"], "stdoutBytes": len(output), "stderrBytes": len(error)}
                row = {"case": case, "runtime": runtime, "phase": "formal-probe", "status": "pass", "binary_sha256": artifact["sha256"],
                       "build_metadata_sha256": AUDIT.sha((directory / "metadata.json").read_bytes()),
                       "input_sha256": AUDIT.sha(input_bytes), "argv_sha256": AUDIT.sha(json.dumps(args, separators=(",", ":")).encode()),
                       "stdout_bytes": len(output), "stdout_sha256": AUDIT.sha(output), "stderr_bytes": len(error), "stderr_sha256": AUDIT.sha(error),
                       "exit_code": result["exitCode"], "signal": None, "process_status": result["status"], "integrity_verified": True,
                       "error": result["error"], "elapsed_ms": 1, "memory_bytes": result["memoryBytes"], "trace_bytes": None, "trace_sha256": None}
                if runtime == "native" and case != "ids":
                    payload = b"boundary-probe\ndelete 0x1234\n"
                    trace = self.file(Path(args[1]), gzip.compress(payload) if case == "trace-gzip" else payload)
                    row.update(trace_bytes=trace["bytes"], trace_sha256=trace["sha256"])
                name = f"{runtime}-{case}"
                for suffix, payload in (("stdin", input_bytes), ("stdout", output), ("stderr", error)):
                    self.file(self.directory / f"{name}.{suffix}", payload)
                self.save(self.directory / f"{name}.json", {"args": args, "result": result, "row": row, "started_ms": 2, "ended_ms": 3})
                rows.append({key: "null" if value is None else str(value).lower() if isinstance(value, bool) else str(value) for key, value in row.items()})
        self.write_rows(rows)
        self.save(self.directory / "summary.json", {"status": "pass", "commit": COMMIT, "phase": "formal-probe",
                  "cases": len(cases), "executions": len(rows), "csv_sha256": AUDIT.sha((self.directory / "results.csv").read_bytes())})

    def write_rows(self, rows):
        with (self.directory / "results.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=AUDIT.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)

    def test_accepts_positive_rows_and_all_columns(self):
        self.assertEqual(AUDIT.audit(self.directory), {"status": "pass", "phase": "formal-probe", "rows": 6, "columns": 21})

    def test_accepts_explicit_unpatched_negative_control(self):
        shutil.rmtree(self.directory)
        self.directory.mkdir()
        self.make_fixture(controls=True)
        self.assertEqual(AUDIT.audit(self.directory)["rows"], 2)

    def test_rejects_every_changed_csv_column(self):
        original = (self.directory / "results.csv").read_bytes()
        rows = list(csv.DictReader(original.decode().splitlines()))
        for column in AUDIT.COLUMNS:
            with self.subTest(column=column):
                changed = [dict(row) for row in rows]
                changed[0][column] = "tampered"
                self.write_rows(changed)
                with self.assertRaises((ValueError, KeyError)):
                    AUDIT.audit(self.directory)
        (self.directory / "results.csv").write_bytes(original)

    def test_rejects_source_and_output_corruption(self):
        for relative in ("result/native-ids.stdout", "result/native-ids.stdin", "result/probe-extra-solver-boundaries.mjs",
                         "build/native/extra-solver-boundary.c", "build/native/build-extra-solver-boundaries.py",
                         "build/native/ids", "build/native/btor2tools-source.tar", "build/solver-native/boolector.a",
                         "build/solver-native/objects/bin/boolector", "build/solver-native/compile.log"):
            with self.subTest(path=relative):
                path = self.root / relative
                original = path.read_bytes()
                path.write_bytes(original + b"corruption")
                with self.assertRaises(ValueError):
                    AUDIT.audit(self.directory)
                path.write_bytes(original)

    def test_rejects_missing_and_extra_measurement_files(self):
        path = self.directory / "wasi-ids.stderr"
        path.unlink()
        with self.assertRaises(FileNotFoundError):
            AUDIT.audit(self.directory)
        path.write_bytes(b"")
        (self.directory / "extra").touch()
        with self.assertRaises(ValueError):
            AUDIT.audit(self.directory)

    def test_reaudits_copied_evidence_without_reading_original_data(self):
        with tempfile.TemporaryDirectory() as restored:
            destination = Path(restored) / "copy"
            shutil.copytree(self.root, destination)
            shutil.rmtree(self.root)
            self.assertEqual(AUDIT.audit(destination / "result", evidence_root=destination)["rows"], 6)


if __name__ == "__main__":
    unittest.main()
