import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[2] / "web/formal_process.py"
spec = importlib.util.spec_from_file_location("formal_workspace_test", SOURCE)
adapter = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {"_formal_host": types.SimpleNamespace(spawn_solver=None)}):
    spec.loader.exec_module(adapter)


def frame(changes, payload=b""):
    header = json.dumps({"version": 1, "changes": changes}).encode()
    return struct.pack("<I", len(header)) + header + payload


def entry(path, before, after):
    return {"path": path,
            "beforeSha256": hashlib.sha256(before).hexdigest() if before is not None else None,
            "afterSha256": hashlib.sha256(after).hexdigest() if after is not None else None,
            "length": len(after) if after is not None else 0}


class FormalWorkspaceTest(unittest.TestCase):
    def test_capture_preserves_utf8_newlines_bytes_and_nonzero_process_error(self):
        for text in (False, True):
            for code in (0, 9):
                raw = "日本語\r\nline\rlast\n".encode()
                chunks = iter([raw[:2], raw[2:9], raw[9:], b""])
                calls = []
                handle = types.SimpleNamespace(
                    stdin_close=lambda: calls.append("close"),
                    readline=lambda: types.SimpleNamespace(to_py=lambda: next(chunks)),
                    finish=lambda mode: calls.append(("finish", mode)) or code,
                    terminate=lambda: calls.append("terminate"),
                )
                expected = raw.decode().replace("\r\n", "\n").replace("\r", "\n") if text else raw
                def spawn(args, merge):
                    self.assertEqual(args, ["unit"])
                    self.assertIs(merge, False)
                    return handle
                with self.subTest(text=text, code=code), patch.object(adapter, "spawn_solver", spawn):
                    if code:
                        with self.assertRaises(adapter.CalledProcessError) as error:
                            adapter.check_output(["unit"], text=text)
                        self.assertEqual(error.exception.returncode, code)
                        self.assertEqual(error.exception.output, expected)
                        self.assertEqual(error.exception.cmd, ["unit"])
                    else:
                        self.assertEqual(adapter.check_output(["unit"], text=text), expected)
                self.assertEqual(calls[:2], ["close", ("finish", True)])
                self.assertEqual("terminate" in calls, bool(code))

    def test_capture_rejects_unsupported_options_and_cleans_up_failed_or_excessive_reads(self):
        for options in ({"text": 1}, {"timeout": 1}, {"input": b"x"}, {"shell": True}):
            with self.assertRaises(TypeError):
                adapter.check_output(["unit"], **options)
        for chunks, exception in (([b"x" * (4 * 1024 * 1024 + 1)] * 2, ValueError), ([b"\xff", b""], UnicodeDecodeError)):
            reads = iter(chunks)
            stopped = []
            handle = types.SimpleNamespace(stdin_close=lambda: None,
                readline=lambda: types.SimpleNamespace(to_py=lambda: next(reads)),
                finish=lambda mode: 0, terminate=lambda: stopped.append(True))
            with patch.object(adapter, "spawn_solver", lambda *_: handle), self.assertRaises(exception):
                adapter.check_output(["unit"], text=True)
            self.assertEqual(stopped, [True])

    def test_directory_conflicts_are_rejected_before_other_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a").write_bytes(b"old")
            (root / "z").mkdir()
            with self.assertRaisesRegex(ValueError, "directory"):
                adapter.apply_workspace_delta(frame([entry("a", b"old", b"new"), entry("z", None, b"file")], b"newfile"), root)
            self.assertEqual((root / "a").read_bytes(), b"old")

    def test_only_single_allowlisted_commands_are_tokenized_without_a_shell(self):
        calls = []
        host = types.SimpleNamespace(spawn_process=lambda args, cwd: calls.append((args, cwd)))
        with patch.dict(sys.modules, {"_formal_host": host}):
            adapter.SbyPopen("cd result/src; yosys -ql ../model/design.log ../model/design.ys", logstderr=True)
            self.assertEqual(calls, [(["yosys", "-ql", "../model/design.log", "../model/design.ys"], "result/src")])
            for command in ("cd result; sh -c evil", "cd ../outside; yosys a", "cd result; yosys a && evil",
                            "cd result; yosys a || evil", "cd result; yosys a > output", "cd result; yosys $(evil)",
                            "cd result; yosys `evil`", "cd result; yosys a; evil", "cd result; yosys a >> output"):
                with self.subTest(command=command), self.assertRaises(ValueError):
                    adapter.SbyPopen(command, logstderr=True)
            self.assertEqual(len(calls), 1)

    def test_parent_logs_survive_add_change_and_delete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input").write_bytes(b"old")
            (root / "obsolete").write_bytes(b"remove")
            (root / "logfile").write_bytes(b"parent later")
            changes = [entry("input", b"old", b"new"), entry("model/output", None, b"artifact"),
                       entry("obsolete", b"remove", None)]
            adapter.apply_workspace_delta(frame(changes, b"newartifact"), root)
            self.assertEqual((root / "input").read_bytes(), b"new")
            self.assertEqual((root / "model/output").read_bytes(), b"artifact")
            self.assertEqual((root / "logfile").read_bytes(), b"parent later")
            self.assertFalse((root / "obsolete").exists())

    def test_corruption_is_checked_before_any_file_is_written(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input").write_bytes(b"old")
            changes = [entry("input", b"old", b"new"), entry("output", None, b"proof")]
            for broken in (frame(changes, b"newwrong"), frame(changes, b"newproo"),
                           frame(changes, b"newproofextra"), frame([entry("../outside", None, b"x")], b"x")):
                with self.assertRaises(ValueError):
                    adapter.apply_workspace_delta(broken, root)
                self.assertEqual((root / "input").read_bytes(), b"old")
                self.assertFalse((root / "output").exists())

    def test_snapshot_conflict_symlink_and_boolean_length_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "input").write_bytes(b"parent")
            with self.assertRaisesRegex(ValueError, "conflict"):
                adapter.apply_workspace_delta(frame([entry("input", b"old", b"new")], b"new"), root)
            malformed = entry("output", None, b"x")
            malformed["length"] = True
            with self.assertRaises(ValueError):
                adapter.apply_workspace_delta(frame([malformed], b"x"), root)
            (root / "link").symlink_to(root / "input")
            with self.assertRaisesRegex(ValueError, "file type"):
                adapter.apply_workspace_delta(frame([]), root)


if __name__ == "__main__":
    unittest.main()
