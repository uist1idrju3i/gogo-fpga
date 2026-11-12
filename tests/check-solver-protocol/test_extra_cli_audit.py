import copy
import csv
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import tarfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cli_audit", ROOT / "scripts/audit-extra-solver-cli.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)
COMMIT = "a" * 40
OLD = "b" * 40
SOURCE = "c" * 40


class ExtraCliAuditTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root / "build/trial"
        self.directory.mkdir(parents=True)
        self.committed = {file: (file + " fixture\n").encode() for file in AUDIT.SOURCES}
        self.committed.update({"scripts/build-solver-probe.py": b"builder fixture\n",
                               "scripts/wasi-meson-compiler.py": b"compiler fixture\n",
                               "requirements-formal-build.txt": b"meson==fixture\n"})
        self.setup = {"format": 2, "phase": "formal-probe", "solver": "bitwuzla", "commit": COMMIT,
                      "worktree": "", "repository": str(self.root), "cases": AUDIT.fixtures(), "sources": {},
                      "argv": [], "builds": [], "negative_build": None}
        for file in AUDIT.SOURCES:
            data = self.committed[file]
            self.setup["sources"][file] = AUDIT.sha(data)
            self.write(self.directory / file.replace("/", "__"), data)
        common = {"patches/bitwuzla-wasi-time-limit.patch", "patches/bitwuzla-wasi-rss.patch",
                  "patches/cadical-wasi-process-boundary.patch", "patches/cadical-wasi-random-seed.patch"}
        for index, runtime in enumerate(("native", "wasi", "wasi")):
            directory = self.root / f"build/binary-{index}"
            directory.mkdir()
            self.setup["argv"].extend([("--native", "--wasi", "--negative-wasi")[index], str(directory)])
            info = {"format": 1, "status": "built", "solver": "bitwuzla", "runtime": runtime,
                    "worktree_status": "", "base_commit": OLD if index == 2 else COMMIT,
                    "source": {"commit": SOURCE, "version": "fixture"}, "commands": [], "patches": [],
                    "script_snapshot": "build-solver-probe.py", "script_sha256": AUDIT.sha(self.committed["scripts/build-solver-probe.py"]),
                    "meson": "fixture\n", "meson_dependencies": [], "libraries": {}}
            self.write(directory / "build-solver-probe.py", self.committed["scripts/build-solver-probe.py"])
            patches = {"patches/bitwuzla-gmp-limb-width.patch"} if index == 0 else common if index == 2 else common | {"patches/bitwuzla-gmp-limb-width.patch", "patches/bitwuzla-wasi-exit.patch"}
            for file in sorted(patches):
                data = (file + " fixture\n").encode()
                self.committed[file] = data
                name = Path(file).name
                info["patches"].append({"path": file, "snapshot": name, "sha256": AUDIT.sha(data)})
                self.write(directory / name, data)
            self.write(directory / "configure.log", b"configured\n")
            info["commands"].append({"label": "configure", "exit_status": 0, "log_sha256": AUDIT.sha(b"configured\n"),
                                     "argv": ["meson", "setup", "--wrap-mode=nodownload", "-Dtesting=disabled", "-Dunit_testing=disabled", "-Ddefault_library=static", "-Doptimization=2", "-Dstrip=false"]})
            self.write(directory / "meson-machine.ini", b"machine fixture\n")
            info["meson_machine_sha256"] = AUDIT.sha(b"machine fixture\n")
            if index:
                info["bitwuzla_native_rss_available"] = False
                info["cadical_native_rss_available"] = False
                data = self.committed["scripts/wasi-meson-compiler.py"]
                self.write(directory / "wasi-meson-compiler.py", data)
                info["meson_compiler_adapter_sha256"] = AUDIT.sha(data)
            for name, headers in (("gmp", ("gmp.h", "gmpxx.h")), ("mpfr", ("mpfr.h",))):
                info[name] = {"version": "1.0", "headers": {}, "licenses": {"COPYING": AUDIT.sha(b"license fixture\n")}}
                self.write(directory / f"{name}-source/COPYING", b"license fixture\n")
                archive = self.archive({f"{name}-1.0/COPYING": b"license fixture\n"})
                self.write(directory / f"{name}-1.0.tar.xz", archive)
                info[name]["archive_sha256"] = AUDIT.sha(archive)
                for header in headers:
                    data = (header + " fixture\n").encode()
                    self.write(directory / "dependencies/include" / header, data)
                    info[name]["headers"][header] = AUDIT.sha(data)
                file = f"dependencies/lib/lib{name}.a"
                self.write(directory / file, b"archive fixture\n")
                info["libraries"][file] = {"bytes": 16, "sha256": AUDIT.sha(b"archive fixture\n")}
                info[name]["library_sha256"] = info["libraries"][file]["sha256"]
                info["meson_dependencies"].append({"name": name, "version": "1.0", "compile_args": [f"-I{directory}/dependencies/include"],
                                                   "link_args": [f"{directory}/dependencies/lib/lib{name}.a", *([f"{directory}/dependencies/lib/libgmp.a"] if name == "mpfr" else [])]})
            self.committed["RESEARCH.md"] = "".join(f"| {name} | 1.0 | `{info[name]['archive_sha256']}` | `https://fixture.test/{name}-1.0.tar.xz` |\n" for name in ("gmp", "mpfr")).encode()
            info["wraps"] = {}
            info["dependencies"] = {}
            for name in ("cadical", "symfpu"):
                archive = self.archive({f"{name}/LICENSE" if name == "cadical" else "LICENSE": b"license fixture\n"}, "d" * 40 if name == "symfpu" else None)
                if name == "cadical":
                    wrap = {"directory": name, "source_url": "https://fixture.test/cadical.tar.gz", "source_filename": "cadical.tar.gz", "source_hash": AUDIT.sha(archive), "patch_directory": name}
                    section = "wrap-file"
                else:
                    wrap = {"url": "https://fixture.test/symfpu.git", "revision": "d" * 40, "depth": "1", "patch_directory": name}
                    section = "wrap-git"
                data = (f"[{section}]\n" + "".join(f"{key} = {value}\n" for key, value in wrap.items())).encode()
                self.committed[f"subprojects/{name}.wrap"] = data
                self.write(directory / f"source/subprojects/{name}.wrap", data)
                info["wraps"][name] = {**wrap, "wrap_sha256": AUDIT.sha(data)}
                self.write(directory / ("cadical.tar.gz" if name == "cadical" else "symfpu-source.tar"), archive)
                info["dependencies"][name] = {"url": wrap.get("url", wrap.get("source_url")), "archive_sha256": AUDIT.sha(archive),
                                               "licenses": {"LICENSE": AUDIT.sha(b"license fixture\n")}, "overlay": {"meson.build": AUDIT.sha(b"overlay fixture\n")}}
                if name == "symfpu":
                    info["dependencies"][name]["commit"] = wrap["revision"]
                self.write(directory / f"source/subprojects/{name}/LICENSE", b"license fixture\n")
                self.write(directory / f"source/subprojects/{name}/meson.build", b"overlay fixture\n")
                self.write(directory / f"source/subprojects/packagefiles/{name}/meson.build", b"overlay fixture\n")
                self.committed[f"subprojects/packagefiles/{name}/meson.build"] = b"overlay fixture\n"
            payload = (b"\x7fELF" if index == 0 else b"\0asm\x01\0\0\0") + f"binary-{index}".encode()
            self.write(directory / "objects/src/main/bitwuzla", payload)
            info["artifact"] = {"path": "objects/src/main/bitwuzla", "bytes": len(payload), "sha256": AUDIT.sha(payload)}
            data = self.save(directory / "metadata.json", info)
            info["metadata_sha256"] = AUDIT.sha(data)
            if index == 2:
                self.setup["negative_build"] = info
            else:
                self.setup["builds"].append(info)
        syntax = next(item for item in self.setup["cases"] if item["name"] == "syntax")
        matrix = [(index, runtime, fixture) for fixture in self.setup["cases"] for index, runtime in enumerate(("native", "wasi"))]
        matrix.append((2, "wasi", {**syntax, "name": "syntax-before-exit-fix", "status": "runtime-error", "exit": None, "stdout": ""}))
        self.rows = []
        for index, runtime, fixture in matrix:
            expected = {"status": "exited", **fixture, **(fixture.get("wasi", {}) if runtime == "wasi" else {})}
            build = self.setup["negative_build"] if index == 2 else self.setup["builds"][index]
            out = expected.get("stdout", "").encode()
            err = expected.get("stderr", "").encode()
            if fixture["name"].startswith("syntax"):
                err = b"[error] <stdin>:1:19: expected command at 'not-a-command'\n"
            if fixture["name"] == "version":
                out = b"fixture\n"
            if fixture["name"] == "help":
                out = b"Usage:\n  bitwuzla " + b"options\n" * 100
            memory = 33554432 if runtime == "wasi" and expected["status"] == "exited" else None
            result = {"status": expected["status"], "exitCode": expected["exit"], "signal": None, "memoryBytes": memory,
                      "error": "unreachable" if expected["status"] == "runtime-error" else None,
                      "integrityVerified": True, "sha256": build["artifact"]["sha256"], "stdoutBytes": len(out), "stderrBytes": len(err)}
            record = {"runtime": runtime, "case": fixture["name"], "status": result["status"], "exit_code": result["exitCode"],
                      "signal": None, "elapsed_ms": 1, "wasm_memory_bytes": memory, "input_sha256": AUDIT.sha(fixture["input"].encode()),
                      "stdout_sha256": AUDIT.sha(out), "stderr_sha256": AUDIT.sha(err), "binary_sha256": build["artifact"]["sha256"],
                      "build_commit": build["base_commit"], "metadata_sha256": build["metadata_sha256"], "write_error": None,
                      "args": fixture["args"], "started_ms": 1, "ended_ms": 2, "result": result}
            name = f"{runtime}-{fixture['name']}"
            for suffix, data in (("stdin", fixture["input"].encode()), ("stdout", out), ("stderr", err)):
                self.write(self.directory / f"{name}.{suffix}", data)
            self.save(self.directory / f"{name}.json", record)
            self.rows.append({column: "" if record[column] is None else str(record[column]) for column in AUDIT.COLUMNS})
        self.save(self.directory / "setup.json", self.setup)
        self.write_rows(self.rows)
        self.git = patch.object(AUDIT.subprocess, "check_output", side_effect=self.git_output)
        self.git.start()
        self.addCleanup(self.git.stop)

    def git_output(self, command, cwd):
        if "--name-only" in command:
            return ("\n".join(file for file in self.committed if file.startswith(command[-1])) + "\n").encode()
        if command[1] == "ls-tree":
            return f"160000 commit {SOURCE}\tvendor/bitwuzla\n".encode()
        self.assertEqual(command[1], "show")
        return self.committed[command[2].split(":", 1)[1]]

    def archive(self, files, commit=None):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT, pax_headers={"comment": commit} if commit else None) as archive:
            for file, data in files.items():
                entry = tarfile.TarInfo(file)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        return buffer.getvalue()

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def save(self, path, value):
        data = (json.dumps(value, indent=2) + "\n").encode()
        self.write(path, data)
        return data

    def write_rows(self, rows):
        with (self.directory / "results.csv").open("w", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=AUDIT.COLUMNS)
            writer.writeheader()
            writer.writerows(rows)
        self.save(self.directory / "summary.json", {"status": "pass", "phase": "formal-probe", "commit": COMMIT,
                  "cases": 14, "executions": 29, "csv_sha256": AUDIT.sha((self.directory / "results.csv").read_bytes())})

    def test_accepts_every_positive_and_explicit_boundary_row(self):
        self.assertEqual(AUDIT.audit(self.directory), {"status": "pass", "phase": "formal-probe", "rows": 29, "columns": 14})

    def test_rejects_every_changed_csv_column(self):
        for column in AUDIT.COLUMNS:
            rows = copy.deepcopy(self.rows)
            rows[0][column] = "changed"
            self.write_rows(rows)
            with self.subTest(column=column), self.assertRaisesRegex(ValueError, "CSV column differs"):
                AUDIT.audit(self.directory)

    def test_rejects_missing_and_extra_rows(self):
        for rows in (self.rows[:-1], self.rows + [self.rows[0]]):
            self.write_rows(rows)
            with self.subTest(rows=len(rows)), self.assertRaisesRegex(ValueError, "CLI rows"):
                AUDIT.audit(self.directory)

    def test_rejects_mutated_stdout_stderr_and_stdin(self):
        for suffix in ("stdout", "stderr", "stdin"):
            file = self.directory / f"wasi-syntax.{suffix}"
            original = file.read_bytes()
            self.write(file, b"changed")
            with self.subTest(suffix=suffix), self.assertRaisesRegex(ValueError, "Hashed bytes differ"):
                AUDIT.audit(self.directory)
            self.write(file, original)

    def test_rejects_status_reclassification_even_when_csv_agrees(self):
        file = self.directory / "wasi-syntax-before-exit-fix.json"
        record = json.loads(file.read_bytes())
        record["status"] = record["result"]["status"] = "exited"
        self.save(file, record)
        self.rows[-1]["status"] = "exited"
        self.write_rows(self.rows)
        with self.assertRaisesRegex(ValueError, "Unexpected process status"):
            AUDIT.audit(self.directory)

    def test_rejects_dirty_formal_worktree(self):
        self.setup["worktree"] = " M scripts/probe-extra-solver-cli.mjs\n"
        self.save(self.directory / "setup.json", self.setup)
        with self.assertRaisesRegex(ValueError, "Dirty formal measurement"):
            AUDIT.audit(self.directory)

    def test_rejects_changed_harness_even_with_matching_digest(self):
        file = AUDIT.SOURCES[0]
        self.write(self.directory / file.replace("/", "__"), b"changed")
        self.setup["sources"][file] = AUDIT.sha(b"changed")
        self.save(self.directory / "setup.json", self.setup)
        with self.assertRaisesRegex(ValueError, "Harness commit mismatch"):
            AUDIT.audit(self.directory)

    def test_rejects_mutated_binary_header_library_and_log(self):
        for relative in ("objects/src/main/bitwuzla", "dependencies/include/gmpxx.h", "dependencies/lib/libgmp.a", "configure.log",
                         "gmp-1.0.tar.xz", "gmp-source/COPYING", "cadical.tar.gz", "symfpu-source.tar", "source/subprojects/cadical.wrap",
                         "source/subprojects/cadical/LICENSE", "source/subprojects/cadical/meson.build", "source/subprojects/packagefiles/symfpu/meson.build"):
            file = self.root / "build/binary-0" / relative
            original = file.read_bytes()
            self.write(file, b"changed")
            with self.subTest(file=relative), self.assertRaisesRegex(ValueError, "Hashed bytes differ"):
                AUDIT.audit(self.directory)
            self.write(file, original)

    def test_rejects_missing_or_unexpected_evidence_files(self):
        self.write(self.directory / "extra.txt", b"extra")
        with self.assertRaisesRegex(ValueError, "Unexpected CLI evidence files"):
            AUDIT.audit(self.directory)

    def test_rejects_memory_and_worker_integrity_reclassification(self):
        file = self.directory / "wasi-eof.json"
        original = file.read_bytes()
        for key, value in (("memoryBytes", 0), ("integrityVerified", False), ("sha256", "wrong")):
            record = json.loads(original)
            record["result"][key] = value
            self.save(file, record)
            with self.subTest(key=key), self.assertRaises(ValueError):
                AUDIT.audit(self.directory)
        self.write(file, original)

    def replace_build_metadata(self, info):
        data = self.save(self.root / "build/binary-0/metadata.json", info)
        info["metadata_sha256"] = AUDIT.sha(data)
        self.setup["builds"][0] = info
        self.save(self.directory / "setup.json", self.setup)
        for row in self.rows:
            if row["runtime"] == "native":
                file = self.directory / f"native-{row['case']}.json"
                record = json.loads(file.read_bytes())
                record["metadata_sha256"] = info["metadata_sha256"]
                self.save(file, record)
                row["metadata_sha256"] = info["metadata_sha256"]
        self.write_rows(self.rows)

    def test_rejects_invalid_build_even_after_all_metadata_hashes_agree(self):
        original = (self.root / "build/binary-0/metadata.json").read_bytes()
        changes = [
            lambda i: i.update(status="error"),
            lambda i: i.update(worktree_status=" M driver.py"),
            lambda i: i.update(meson="unexpected"),
            lambda i: i["commands"][0].update(exit_status=1),
            lambda i: i["commands"][0].update(exit_status=False),
            lambda i: i["commands"][0]["argv"].remove("--wrap-mode=nodownload"),
            lambda i: i["patches"].append(i["patches"][0]),
            lambda i: i["meson_dependencies"][0].update(compile_args=["-I/usr/include"]),
            lambda i: i["gmp"].update(version="99.0"),
            lambda i: i["gmp"].update(library_sha256="wrong"),
            lambda i: i["wraps"]["symfpu"].update(revision="e" * 40),
            lambda i: i["dependencies"]["cadical"].update(overlay={}),
        ]
        for index, change in enumerate(changes):
            info = json.loads(original)
            change(info)
            self.replace_build_metadata(info)
            with self.subTest(index=index), self.assertRaises(ValueError):
                AUDIT.audit(self.directory)

    def test_rejects_invalid_elapsed_time_arguments_and_pipe_error(self):
        file = self.directory / "wasi-syntax.json"
        original = file.read_bytes()
        for field, value in (("elapsed_ms", -1), ("started_ms", True), ("ended_ms", float("nan")),
                             ("args", ["--unexpected"]), ("write_error", "unrecognized failure")):
            record = json.loads(original)
            record[field] = value
            self.save(file, record)
            with self.subTest(field=field), self.assertRaises(ValueError):
                AUDIT.audit(self.directory)
        self.write(file, original)

    def test_can_relocate_evidence_without_reading_original_build_directories(self):
        import shutil
        restored = self.root / "restored"
        shutil.copytree(self.root / "build", restored / "build")
        shutil.rmtree(self.root / "build")
        self.assertEqual(AUDIT.audit(restored / "build/trial", restored)["rows"], 29)


if __name__ == "__main__":
    unittest.main()
