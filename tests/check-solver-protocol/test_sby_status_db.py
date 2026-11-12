import ast
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("sby_status_reader", ROOT / "scripts/read-sby-status-db.py")
READER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READER)
SOURCE = ast.parse((ROOT / "vendor/sby/sbysrc/sby_status.py").read_text())
SCHEMA = next(ast.literal_eval(node.value) for node in SOURCE.body
              if isinstance(node, ast.Assign) and any(isinstance(name, ast.Name) and name.id == "SQLSCRIPT" for name in node.targets))


class SbyStatusReaderTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "status.sqlite"
        with sqlite3.connect(self.path) as connection:
            connection.executescript(SCHEMA)
            connection.execute("INSERT INTO task VALUES(1, 'result', NULL, 'bmc', 1)")
            connection.execute("INSERT INTO task_status VALUES(1, 1, 'PASS', 'null', 2)")

    def test_read_preserves_bytes_and_removes_only_creation_times(self):
        original = self.path.read_bytes()
        baseline = READER.read_status(self.path)
        self.assertEqual(self.path.read_bytes(), original)
        self.assertEqual(baseline["task_status"]["rows"], [[1, 1, "PASS", "null"]])
        with sqlite3.connect(self.path) as connection:
            connection.execute("UPDATE task SET created=42")
            connection.execute("UPDATE task_status SET created=43")
        self.assertEqual(READER.read_status(self.path), baseline)
        with sqlite3.connect(self.path) as connection:
            connection.execute("UPDATE task_status SET status='UNKNOWN'")
        self.assertNotEqual(READER.read_status(self.path), baseline)

    def test_missing_corrupt_or_unsettled_databases_fail_closed(self):
        with self.assertRaises(FileNotFoundError):
            READER.read_status(self.path.parent / "absent")
        journal = Path(str(self.path) + "-wal")
        journal.write_bytes(b"pending")
        with self.assertRaisesRegex(ValueError, "Unsettled"):
            READER.read_status(self.path)
        journal.unlink()
        self.path.write_bytes(b"not SQLite")
        with self.assertRaises(sqlite3.DatabaseError):
            READER.read_status(self.path)

    def test_unknown_schema_or_foreign_keys_are_not_silently_ignored(self):
        with sqlite3.connect(self.path) as connection:
            connection.execute("INSERT INTO task_status VALUES(2, 999, 'PASS', 'null', 3)")
        with self.assertRaisesRegex(ValueError, "foreign key"):
            READER.read_status(self.path)
        with sqlite3.connect(self.path) as connection:
            connection.execute("DELETE FROM task_status WHERE id=2")
            connection.execute("CREATE TABLE unexpected(value TEXT)")
        with self.assertRaisesRegex(ValueError, "schema"):
            READER.read_status(self.path)


if __name__ == "__main__":
    unittest.main()
