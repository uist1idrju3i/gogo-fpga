import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("control_audit", ROOT / "scripts/audit-formal-controls.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class FormalControlsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.out = Path(directory.name)
        sha = AUDIT.digest(b"binary")
        meta = {"format": 1, "commit": "a" * 40, "worktree": "", "preliminary": False,
                "deadlineMs": 15000, "cleanupDeadlineMs": 5000, "snapshots": {},
                "yosys": {"sha256": sha, "shareSha256": sha}, "probes": {},
                "sources": {"assets": []}}
        for name in AUDIT.SNAPSHOTS | {"scripts/measure-formal-controls.py"}:
            self.raw("snapshots/" + name, b"snapshot")
            meta["snapshots"][name] = AUDIT.digest(b"snapshot")
        self.write("assets/manifest.json", meta["sources"])
        for name in ["yosys.wasm", "yosys-share.tar"]:
            self.raw("inputs/" + name, b"binary")
        for solver in ["yices2", "z3"]:
            build = {"status": "built", "worktree_status": "", "runtime": "wasi", "solver": solver,
                     "artifact": {"bytes": 6, "sha256": sha}}
            self.write("build/" + solver + ".json", build)
            self.raw("inputs/" + solver + ".wasm", b"binary")
            meta["probes"][solver] = {"sha256": sha, "metadataSha256": AUDIT.digest((self.out / ("build/" + solver + ".json")).read_bytes())}
        rows = []
        matrix = [(solver + "-" + case, solver, case) for solver in ["yices2", "z3"] for case in [*AUDIT.NORMAL, *AUDIT.FAULTS]]
        matrix.extend(("restriction-" + case, "yices2", case) for case in AUDIT.RESTRICTIONS)
        for label, solver, case in matrix:
            events = []
            normal, live = case in AUDIT.NORMAL, case in ["cancel", "timeout", "crash", "protocol"]
            kinds = ["python", "python", "solver"] if normal or live else ["python"]
            if normal or case in ["corrupt-delta", "conflict-delta"]:
                kinds.append("wasi")
            workers = [{"id": i, "kind": kind, "root": i == 0, "stopped": True, "exited": True} for i, kind in enumerate(kinds)]

            def event(i, name, **details):
                events.append({"worker": i, "kind": kinds[i], "event": name, "ms": len(events) + 1, **details})

            for i, kind in enumerate(kinds):
                event(i, "start", jobId=f"job-{i}", entrypoint="sby" if i == 0 else "smtbmc" if kind == "python" else None, sha256=sha)
                if kind == "python":
                    event(i, "native-guards-installed", resourceAvailable=False, inheritedMakeflags="--jobserver-auth=3,4 -j8")
                    event(i, "environment-after-run", makeflags="")
                if kind == "solver":
                    event(i, "solver-stdin-wait", channel="stdin", index=3, sha256=sha)
            if live and case != "timeout":
                event(0, "fault-trigger", mode=case, activeWorkers=list(range(len(kinds))))
            if case == "crash":
                event(0, "root-crash", exitCode=17)
            if case == "corrupt-delta":
                event(0, "delta-corrupted", bytes=10, beforeSha256="0" * 64, afterSha256="1" * 64)
            if case == "conflict-delta":
                for name in ["delta-conflict", "conflict-root-preserved"]:
                    event(0, name, sha256=AUDIT.digest(b"concurrent root write\n"))
            for i in reversed(range(len(kinds))):
                crash = case == "crash" and i == 0
                event(i, "exit", code=17 if crash else 0, expectedTermination=not crash, acknowledged=not crash)
            transport = {"jobId": "job-0", "elapsedMs": 15001 if case == "timeout" else 100,
                         "status": "exited" if normal else "runtime-error" if case in AUDIT.RESTRICTIONS else AUDIT.FAULTS[case],
                         "children": [{"role": "tool", "args": ["yosys-smtbmc"], "status": "exited", "integrityVerified": True}]}
            stdout, stderr, files, status = "", "", {}, None
            if normal:
                fixture, status, code = AUDIT.NORMAL[case]
                transport.update(exitCode=code, integrityVerified=True)
                stdout = f"Elapsed process time unavailable in the browser\n DONE ({status}, rc={code})\n"
                for name in AUDIT.SBY.artifact_names(fixture):
                    raw = (f"{status} 0 0\n" if name == "result/status" else "fixture").encode()
                    self.raw(label + "/output/" + name, raw)
                    files[name] = {"bytes": len(raw), "sha256": AUDIT.digest(raw)}
            if case in AUDIT.RESTRICTIONS:
                stderr = AUDIT.RESTRICTIONS[case]
            if case in ["corrupt-delta", "conflict-delta"]:
                stderr = "Workspace delta hash mismatch:" if case == "corrupt-delta" else "Workspace delta conflict:"
            self.write(label + "/transport.json", transport)
            self.write(label + "/events.json", events)
            self.write(label + "/workers.json", workers)
            self.write(label + "/files.json", files)
            self.raw(label + "/stdout.log", stdout.encode())
            self.raw(label + "/stderr.log", stderr.encode())
            row = dict(zip(AUDIT.COLUMNS, [label, solver, transport["status"], transport.get("exitCode"), status, transport["elapsedMs"],
                                         len(files), len(workers), len(workers), int(normal or live), sha, None]))
            rows.append(row)
            self.write(label + "/result.json", row)
        self.write("metadata.json", meta)
        self.write("results.json", {"preliminary": False, "rows": rows})
        self.raw("results.csv", AUDIT.rows_csv(rows))

    def raw(self, name, data):
        target = self.out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def write(self, name, data):
        self.raw(name, (json.dumps(data, ensure_ascii=True, indent=2) + "\n").encode())

    def mutate(self, name, change):
        data = json.loads((self.out / name).read_bytes())
        change(data)
        self.write(name, data)

    def test_complete_matrix(self):
        result = AUDIT.audit(self.out)
        self.assertEqual((result["status"], result["rows"], result["columns"]), ("pass", 23, 12))

    def test_each_csv_column_is_rederived(self):
        original = (self.out / "results.csv").read_bytes()
        results = json.loads((self.out / "results.json").read_bytes())
        for column in AUDIT.COLUMNS:
            with self.subTest(column=column):
                rows = [dict(row) for row in results["rows"]]
                rows[0][column] = "tampered"
                self.raw("results.csv", AUDIT.rows_csv(rows))
                with self.assertRaises(ValueError):
                    AUDIT.audit(self.out)
        self.raw("results.csv", original)

    def test_negative_controls(self):
        mutations = [
            ("metadata.json", lambda d: d.update(worktree="dirty")),
            ("metadata.json", lambda d: d.update(deadlineMs=1)),
            ("metadata.json", lambda d: d["snapshots"].pop(next(iter(d["snapshots"])))),
            ("results.json", lambda d: d["rows"].pop()),
            ("yices2-cancel/transport.json", lambda d: d.update(status="exited", exitCode=0, integrityVerified=True)),
            ("yices2-timeout/transport.json", lambda d: d.update(elapsedMs=1)),
            ("yices2-crash/events.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["event"] != "root-crash"])),
            ("yices2-protocol/events.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["event"] != "fault-trigger"])),
            ("yices2-cancel/events.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["event"] != "solver-stdin-wait"])),
            ("yices2-conflict-delta/events.json", lambda d: d.__setitem__(slice(None), [e for e in d if e["event"] != "conflict-root-preserved"])),
            ("yices2-bounded-pass/workers.json", lambda d: d[0].update(exited=False)),
            ("yices2-engine-unknown/transport.json", lambda d: d.update(exitCode=0)),
        ]
        for name, mutation in mutations:
            with self.subTest(name=name):
                original = (self.out / name).read_bytes()
                self.mutate(name, mutation)
                with self.assertRaises(ValueError):
                    AUDIT.audit(self.out)
                self.raw(name, original)

    def test_extra_output_and_symlink_are_rejected(self):
        self.raw("yices2-cancel/output/result/PASS", b"forged")
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)
        (self.out / "yices2-cancel/output/result/PASS").unlink()
        (self.out / "yices2-cancel/output/result/PASS").symlink_to(self.out / "metadata.json")
        with self.assertRaises(ValueError):
            AUDIT.audit(self.out)


if __name__ == "__main__":
    unittest.main()
