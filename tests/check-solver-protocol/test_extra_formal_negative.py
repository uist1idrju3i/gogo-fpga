import csv
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("extra_negative", Path(__file__).resolve().parents[2] / "scripts/negative-extra-formal.py")
NEGATIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(NEGATIVE)


class ExtraFormalNegativeTest(unittest.TestCase):
    def test_real_condition_matrix_and_atomic_hardlink_isolation(self):
        mutations = NEGATIVE.mutations()
        self.assertEqual(len(mutations), 20)
        self.assertEqual(len({name for name, _, _ in mutations}), 20)
        with tempfile.TemporaryDirectory() as name:
            directory = Path(name)
            original = directory / "original"
            cloned = directory / "cloned"
            original.write_bytes(b"original")
            NEGATIVE.clone_file(original, cloned)
            self.assertEqual(original.stat().st_ino, cloned.stat().st_ino)
            NEGATIVE.atomic_bytes(cloned, b"changed")
            self.assertEqual(original.read_bytes(), b"original")
            self.assertEqual(cloned.read_bytes(), b"changed")
            self.assertNotEqual(original.stat().st_ino, cloned.stat().st_ino)
            NEGATIVE.atomic_bytes(cloned, b"original")
            self.assertEqual(original.read_bytes(), cloned.read_bytes())

    def test_csv_mutation_changes_only_the_selected_cell(self):
        raw = b'"status","error","extra"\n"exited","","comma, quote \\"""\n'
        for key, value in [("status", "FORGED_PASS"), ("error", "changed")]:
            before = list(csv.DictReader(io.StringIO(raw.decode())))
            after = list(csv.DictReader(io.StringIO(NEGATIVE.changed_csv(raw, key, value).decode())))
            self.assertEqual(set(after[0]), set(before[0]))
            for column in before[0]:
                self.assertEqual(after[0][column], value if column == key else before[0][column])
        with self.assertRaises(ValueError):
            NEGATIVE.changed_csv(raw, "missing", "value")

    def test_each_mutation_is_effective_and_nested_output_is_rejected_before_creation(self):
        metadata = json.dumps({"probes": {solver: {"sha256": "a" * 64} for solver in ["bitwuzla", "boolector"]}}).encode()
        for label, path, modify in NEGATIVE.mutations():
            if path.endswith("metadata.json"):
                raw = metadata
            elif path.endswith("transport.json"):
                raw = b'{"integrityVerified":true}'
            elif path.endswith("summary.json"):
                raw = b'{"status":"pass"}'
            elif path.endswith(".csv"):
                raw = b'"status","error"\n"exited",""\n'
            elif path.endswith("unexpected"):
                raw = None
            else:
                raw = b"data"
            with self.subTest(label=label):
                self.assertNotEqual(modify(raw), raw)
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            runner = root / "runner.py"
            runner.write_text("")
            target = root / "nested"
            with self.assertRaisesRegex(ValueError, "outside"):
                NEGATIVE.run(root, runner, target)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
