import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TRACE = load("formal_trace_adapter", ROOT / "web/formal_trace.py")
SMTIO = load("formal_trace_original_smtio", ROOT / "vendor/yosys/backends/smt2/smtio.py")


class FormalTraceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cwd = os.getcwd()
        os.chdir(self.tmp.name)
        self.addCleanup(os.chdir, self.cwd)

    def emit(self, writer, edge="negedge"):
        writer.add_net(["top", "q"], 3)
        writer.add_clock(["top", "clk"], edge)
        for time in range(3):
            writer.set_time(time)
            writer.set_time(time)
            writer.set_net(["top", "q"], format(time, "03b"))
            writer.set_net(["top", "clk"], "0")
        writer.set_time(3)

    def test_original_vcd_bytes_and_clock_semantics_are_unchanged(self):
        original = io.StringIO()
        self.emit(SMTIO.MkVcd(original))
        captures = []
        with open("trace.vcd", "w") as stream:
            writer = TRACE.recording_writer(SMTIO.MkVcd, captures)(stream)
            self.emit(writer)
        self.assertEqual(Path("trace.vcd").read_text(), original.getvalue())
        self.assertEqual(captures, [writer])
        result = writer.snapshot()
        self.assertEqual(result["sha256"], hashlib.sha256(original.getvalue().encode()).hexdigest())
        self.assertEqual(result["endTime"], 3)
        self.assertEqual([step["time"] for step in result["steps"]], [0, 1, 2])
        self.assertEqual(result["signals"], [
            {"path": ["top", "q"], "width": 3, "clock": None},
            {"path": ["top", "clk"], "width": 1, "clock": "negedge"},
        ])

    def writer(self):
        stream = open("trace.vcd", "w")
        self.addCleanup(stream.close)
        return TRACE.recording_writer(SMTIO.MkVcd, [])(stream)

    def test_records_independent_metadata_before_every_upstream_call(self):
        class ObservedWriter(SMTIO.MkVcd):
            def add_net(writer, path, width):
                self.assertEqual(writer.capture_signals[tuple(path)], (width, None))
                super().add_net(path, width)

            def add_clock(writer, path, edge):
                self.assertEqual(writer.capture_signals[tuple(path)], (1, edge))
                super().add_clock(path, edge)

            def set_time(writer, time):
                self.assertEqual(writer.capture_time, time)
                self.assertEqual(writer.frames[-1]["time"], time)
                super().set_time(time)

            def set_net(writer, path, bits):
                self.assertEqual(writer.frames[-1]["values"][tuple(path)], bits)
                super().set_net(path, bits)

        with open("trace.vcd", "w") as stream:
            writer = TRACE.recording_writer(ObservedWriter, [])(stream)
            self.emit(writer)
        self.assertEqual(writer.snapshot()["endTime"], 3)

    def test_rejects_duplicate_nets_clocks_values_and_invalid_widths(self):
        for width in [0, -1, 4097, True, 1.5, "1", None]:
            with self.subTest(width=width), self.assertRaises(ValueError):
                self.writer().add_net(["top", "q"], width)
        writer = self.writer()
        writer.add_net(["top", "q"], 2)
        for action in [lambda: writer.add_net(["top", "q"], 2),
                       lambda: writer.add_clock(["top", "q"], "posedge"),
                       lambda: writer.add_clock(["top", "c"], "both")]:
            with self.assertRaises(ValueError):
                action()
        writer.set_time(0)
        writer.set_net(["top", "q"], "10")
        with self.assertRaises(ValueError):
            writer.set_net(["top", "q"], "10")

    def test_rejects_unknown_wrong_width_or_malformed_values_and_bad_times(self):
        writer = self.writer()
        writer.add_net(["top", "q"], 2)
        writer.set_time(0)
        for bits in ["0", "000", "?0", "x0", "0z", " 0", 0, None]:
            with self.subTest(bits=bits), self.assertRaises(ValueError):
                writer.set_net(["top", "q"], bits)
        with self.assertRaises(ValueError):
            writer.set_net(["top", "missing"], "00")
        for time in [-1, True, 0.5, 1025]:
            with self.assertRaises(ValueError):
                writer.set_time(time)
        for action in [lambda: writer.add_net(["top", "late"], 1),
                       lambda: writer.add_clock(["top", "late"], "posedge")]:
            with self.assertRaises(ValueError):
                action()

    def test_rejects_incomplete_or_open_vcd_and_resource_overflow(self):
        writer = self.writer()
        writer.add_net(["top", "q"], 1)
        writer.set_time(0)
        writer.set_net(["top", "q"], "0")
        with self.assertRaises(ValueError):
            writer.snapshot()
        writer.f.close()
        with self.assertRaises(ValueError):
            writer.snapshot()
        writer = self.writer()
        writer.add_net(["top", "q"], 1)
        writer.set_time(0)
        with patch.object(TRACE, "MAX_BYTES", 0), self.assertRaises(ValueError):
            writer.set_net(["top", "q"], "0")

    def test_rejects_unsafe_paths_symlinks_and_reserved_capture(self):
        for name in ["../trace", "/trace", "C:trace", "C:/trace", "a\\b", "a/./b", "a//b", "\0", ".", ""]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                TRACE.relative_file(name)
        Path("real").mkdir()
        Path("link").symlink_to("real", target_is_directory=True)
        with self.assertRaises(ValueError):
            TRACE.relative_file("link/trace.vcd")
        with open(TRACE.OUTPUT, "w") as stream, self.assertRaises(ValueError):
            TRACE.recording_writer(SMTIO.MkVcd, [])(stream)

    def upstream(self, body):
        Path("model.smt2").write_text("fixed model")
        Path("smtio.py").write_text("")
        Path("smtbmc.py").write_text(body)
        return patch.object(SMTIO, "__file__", str(Path("smtio.py").resolve()))

    def test_entrypoint_preserves_exit_and_restores_original_writer_and_argv(self):
        body = """from smtio import MkVcd
with open('trace.vcd', 'w') as stream:
    writer = MkVcd(stream)
    writer.add_net(['top', 'q'], 1)
    writer.set_time(0)
    writer.set_net(['top', 'q'], '1')
    writer.set_time(1)
raise SystemExit(1)
"""
        original = SMTIO.MkVcd
        argv = sys.argv
        with self.upstream(body), patch.dict(sys.modules, {"smtio": SMTIO}):
            self.assertEqual(TRACE.main(["model.smt2"]), 1)
        self.assertIs(SMTIO.MkVcd, original)
        self.assertIs(sys.argv, argv)
        result = json.loads(Path(TRACE.OUTPUT).read_text())
        self.assertEqual(result["upstreamExitCode"], 1)
        self.assertEqual(result["model"]["sha256"], hashlib.sha256(b"fixed model").hexdigest())
        self.assertEqual(len(result["traces"]), 1)
        before = Path(TRACE.OUTPUT).read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            TRACE.main(["model.smt2"])
        self.assertEqual(Path(TRACE.OUTPUT).read_bytes(), before)

    def test_exception_cannot_publish_partial_capture(self):
        original = SMTIO.MkVcd
        with self.upstream("raise RuntimeError('incomplete')"), patch.dict(sys.modules, {"smtio": SMTIO}):
            with self.assertRaises(RuntimeError):
                TRACE.main(["model.smt2"])
        self.assertIs(SMTIO.MkVcd, original)
        self.assertFalse(Path(TRACE.OUTPUT).exists())

    def test_changed_model_cannot_publish_capture(self):
        with self.upstream("with open('model.smt2', 'w') as stream:\n    stream.write('changed')"), patch.dict(sys.modules, {"smtio": SMTIO}):
            with self.assertRaisesRegex(ValueError, "model changed"):
                TRACE.main(["model.smt2"])
        self.assertFalse(Path(TRACE.OUTPUT).exists())

    def test_file_arguments_are_checked_before_upstream_can_open_them(self):
        Path("model.smt2").write_text("fixed")
        Path("existing.vcd").write_text("keep")
        for args in [["--dump-vcd", "../escape.vcd", "model.smt2"],
                     ["--dump-vcd=/escape.vcd", "model.smt2"],
                     ["--dump-vcd", "model.smt2", "model.smt2"],
                     ["--dump-yw", TRACE.OUTPUT, "model.smt2"],
                     ["--dump-vcd", "trace.vcd", "--dump-yw", "trace.vcd", "model.smt2"],
                     ["--dump-vcd", "existing.vcd", "model.smt2"],
                     ["--dump-vcd", "trace%.vcd", "model.smt2"],
                     ["--smtc", "missing.smtc", "model.smt2"],
                     ["model.smt2", "another.smt2"]]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                TRACE.main(args)
        self.assertEqual(Path("existing.vcd").read_text(), "keep")
        self.assertEqual(Path("model.smt2").read_text(), "fixed")
        self.assertFalse(Path(TRACE.OUTPUT).exists())

    def test_bounded_entrypoint_rejects_unknown_options_and_invalid_arguments(self):
        for args in [None, [], (), [True], ["\0"], ["model"] * 65, ["--dump-smt2", "unsafe", "model.smt2"]]:
            with self.subTest(args=args), self.assertRaises((ValueError, TRACE.getopt.GetoptError)):
                TRACE.main(args)

    def test_invalid_exit_incomplete_trace_and_json_limit_cannot_publish(self):
        for code in ["True", "-1", "256", "'1'"]:
            with self.subTest(code=code), self.upstream(f"raise SystemExit({code})"), patch.dict(sys.modules, {"smtio": SMTIO}):
                with self.assertRaisesRegex(ValueError, "exit code"):
                    TRACE.main(["model.smt2"])
        body = """from smtio import MkVcd
with open('trace.vcd', 'w') as stream:
    writer = MkVcd(stream)
    writer.add_net(['top', 'q'], 1)
    writer.set_time(0)
    writer.set_net(['top', 'q'], '1')
"""
        with self.upstream(body), patch.dict(sys.modules, {"smtio": SMTIO}), self.assertRaisesRegex(ValueError, "Incomplete"):
            TRACE.main(["model.smt2"])
        with self.upstream("pass"), patch.dict(sys.modules, {"smtio": SMTIO}), patch.object(TRACE, "MAX_BYTES", 0):
            with self.assertRaisesRegex(ValueError, "JSON byte"):
                TRACE.main(["model.smt2"])
        self.assertFalse(Path(TRACE.OUTPUT).exists())

    def test_definition_and_multi_capture_limits_are_aggregate(self):
        captures = []
        writer_class = TRACE.recording_writer(SMTIO.MkVcd, captures)
        with open("a.vcd", "w") as a, open("b.vcd", "w") as b:
            one, two = writer_class(a), writer_class(b)
            with patch.object(TRACE, "MAX_BYTES", 130):
                one.add_net(["a"], 1)
                two.add_net(["b"], 1)
                with self.assertRaisesRegex(ValueError, "byte limit"):
                    two.add_clock(["c"], "posedge")
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                writer_class(a)
        writer = self.writer()
        with patch.object(TRACE, "MAX_SIGNALS", 0), self.assertRaisesRegex(ValueError, "signal count"):
            writer.add_net(["q"], 1)

    def test_failed_output_write_leaves_no_published_capture_or_temporary(self):
        with self.upstream("pass"), patch.dict(sys.modules, {"smtio": SMTIO}):
            with patch.object(TRACE.os, "link", side_effect=OSError("unit publish failure")):
                with self.assertRaisesRegex(OSError, "publish failure"):
                    TRACE.main(["model.smt2"])
        self.assertFalse(Path(TRACE.OUTPUT).exists())
        self.assertEqual(list(Path().glob(".formal-trace-*")), [])

    def test_rejects_missing_samples_invalid_net_paths_and_trace_count_overflow(self):
        writer = self.writer()
        writer.add_net(["top", "q"], 1)
        writer.add_net(["top", "missing"], 1)
        writer.set_time(0)
        writer.set_net(["top", "q"], "0")
        writer.set_time(1)
        writer.f.close()
        with self.assertRaisesRegex(ValueError, "Missing captured signal"):
            writer.snapshot()
        for path in [[], "q", [None], [""], ["\0"], ["a"] * 65, ["a" * 513]]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                TRACE.net_path(path)
        with open("overflow.vcd", "w") as stream, self.assertRaisesRegex(ValueError, "trace count"):
            TRACE.recording_writer(SMTIO.MkVcd, [None] * 64)(stream)

    def test_all_upstream_clock_edges_preserve_original_bytes(self):
        for edge in ["posedge", "negedge", "event"]:
            with self.subTest(edge=edge):
                original = io.StringIO()
                self.emit(SMTIO.MkVcd(original), edge)
                with open("trace.vcd", "w") as stream:
                    writer = TRACE.recording_writer(SMTIO.MkVcd, [])(stream)
                    self.emit(writer, edge)
                self.assertEqual(Path("trace.vcd").read_text(), original.getvalue())
                self.assertEqual(writer.snapshot()["signals"][1]["clock"], edge)


if __name__ == "__main__":
    unittest.main()
