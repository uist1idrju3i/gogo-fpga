import importlib.util
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "check_sim_shards",
    ROOT / ".github/scripts/check-sim-shards.py",
)
check_sim_shards = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_sim_shards)


def report(passed=(), skipped=(), failed=()):
    lines = ["TAP version 13"]
    number = 0
    for name in passed:
        number += 1
        lines.append(f"ok {number} - {name}")
    for name in skipped:
        number += 1
        lines.append(f"ok {number} - {name} # SKIP assigned elsewhere")
    for name in failed:
        number += 1
        lines.append(f"not ok {number} - {name}")
    lines.extend((f"1..{number}", f"# tests {number}", f"# pass {len(passed)}", f"# fail {len(failed)}"))
    return "\n".join(lines) + "\n"


class CheckSimShardsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.table = {"test one": 1, "test two": 2, "test three": 3}
        self.write_reports()

    def tearDown(self):
        self.temp.cleanup()

    def write_reports(self, overrides=None):
        overrides = overrides or {}
        for shard in range(1, 4):
            directory = self.root / f"sim-shard-{shard}"
            directory.mkdir(exist_ok=True)
            selected = [name for name, assigned in self.table.items() if assigned == shard]
            skipped = [name for name, assigned in self.table.items() if assigned != shard]
            text = overrides.get(shard, report(selected, skipped))
            (directory / "sim-shard.tap").write_text(text, encoding="utf-8")

    def test_all_shard_reports_pass_exact_coverage(self):
        self.assertEqual([], check_sim_shards.check_reports(self.table, self.root))

    def test_failed_shard_is_rejected(self):
        self.write_reports({1: report(failed=["test one"])})
        errors = check_sim_shards.check_reports(self.table, self.root)
        self.assertTrue(any("shard 1 has failures" in error for error in errors))

    def test_duplicate_pass_across_shards_is_rejected(self):
        self.write_reports({2: report(passed=["test one", "test two"], skipped=["test three"])})
        errors = check_sim_shards.check_reports(self.table, self.root)
        self.assertTrue(any("multiple shards" in error for error in errors))

    def test_unused_table_entry_is_rejected(self):
        self.write_reports()
        self.table["unused test"] = 3
        errors = check_sim_shards.check_reports(self.table, self.root)
        self.assertTrue(any("unused shard table entries" in error for error in errors))

    def test_passed_test_missing_from_table_is_rejected(self):
        self.write_reports({1: report(passed=["unmapped test"], skipped=["test two", "test three"])})
        errors = check_sim_shards.check_reports(self.table, self.root)
        self.assertTrue(any("missing from shards.json" in error for error in errors))

    def test_invalid_shard_assignment_is_rejected(self):
        self.assertTrue(
            any("shard numbers" in error for error in check_sim_shards.check_reports({"test": 4}, self.root))
        )


if __name__ == "__main__":
    unittest.main()
