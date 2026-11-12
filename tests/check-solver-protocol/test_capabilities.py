import ast
import json
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]


def choices(node, expression):
    if isinstance(node, ast.BoolOp):
        return set().union(*(choices(value, expression) for value in node.values))
    if not isinstance(node, ast.Compare) or ast.unparse(node.left) != expression:
        if any(ast.unparse(child) == expression for child in ast.walk(node)):
            raise ValueError("Unrecognized upstream dispatch expression")
        return set()
    if len(node.ops) != 1 or not isinstance(node.ops[0], (ast.Eq, ast.In)):
        raise ValueError("Unrecognized upstream dispatch comparison")
    value = ast.literal_eval(node.comparators[0])
    values = [value] if isinstance(node.ops[0], ast.Eq) else value
    if not isinstance(values, (list, tuple, set)) or not values or any(not isinstance(v, str) for v in values):
        raise ValueError("Unrecognized upstream dispatch values")
    return set(values)


def dispatch(tree, expression):
    result = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If):
            result.update(choices(node.test, expression))
    return result


def original(submodule, path):
    entry = subprocess.check_output(["git", "ls-tree", "HEAD", "--", f"vendor/{submodule}"], cwd=ROOT, text=True)
    mode, kind, commit, _path = entry.split()
    if mode != "160000" or kind != "commit":
        raise ValueError("Missing canonical source gitlink")
    return subprocess.check_output(["git", "-C", str(ROOT / "vendor" / submodule), "show", f"{commit}:{path}"], text=True)


class FormalCapabilitiesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(subprocess.check_output([
            "node", "--input-type=module", "--eval",
            'import { FORMAL_SOLVERS, FORMAL_ENGINES } from "./web/lib/formal-capabilities.mjs";'
            'console.log(JSON.stringify({ solvers: FORMAL_SOLVERS, engines: FORMAL_ENGINES }));',
        ], cwd=ROOT, text=True))
        cls.smtio = ast.parse(original("yosys", "backends/smt2/smtio.py"))
        cls.setup = next(node for node in ast.walk(cls.smtio)
                         if isinstance(node, ast.FunctionDef) and node.name == "setup")

    def test_solver_names_exhaustively_match_the_pinned_smtio_dispatch(self):
        actual = [entry["smtbmc"] for entry in self.catalog["solvers"]]
        self.assertEqual(len(actual), len(set(actual)))
        self.assertEqual(set(actual), dispatch(self.setup, "self.solver"))

    def test_solver_executables_match_upstream_process_commands_not_product_aliases(self):
        commands = {}
        for node in ast.walk(self.setup):
            if not isinstance(node, ast.If):
                continue
            names = choices(node.test, "self.solver")
            for statement in ast.walk(node):
                if not isinstance(statement, ast.Assign) or not any(
                        ast.unparse(target) == "self.popen_vargs" for target in statement.targets):
                    continue
                value = statement.value
                while isinstance(value, ast.BinOp) and isinstance(value.op, ast.Add):
                    value = value.left
                self.assertIsInstance(value, ast.List)
                first = value.elts[0]
                for name in names:
                    command = name if ast.unparse(first) == "self.solver" else ast.literal_eval(first)
                    commands.setdefault(name, set()).add(command)
        for entry in self.catalog["solvers"]:
            with self.subTest(solver=entry["id"]):
                expected = {entry["command"]} if entry["command"] is not None else set()
                self.assertEqual(commands.get(entry["smtbmc"], set()), expected)

    def test_sby_engine_names_and_each_mode_match_the_pinned_dispatch(self):
        modes = {}
        for mode in ("bmc", "prove", "cover", "live"):
            tree = ast.parse(original("sby", f"sbysrc/sby_mode_{mode}.py"))
            modes[mode] = dispatch(tree, "engine[0]")
        entries = [entry for entry in self.catalog["engines"] if entry["kind"] == "sby"]
        names = [entry["id"] for entry in entries]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(set(names), set.union(*modes.values()))
        for entry in entries:
            with self.subTest(engine=entry["id"]):
                self.assertEqual(set(entry["modes"]), {mode for mode, engines in modes.items() if entry["id"] in engines})

    def test_boolector_maintenance_end_is_backed_by_its_pinned_release_record(self):
        news = original("boolector", "NEWS")
        self.assertIn("This is the final release of Boolector", news)
        self.assertIn("maintenance has\nstopped.", news)
        self.assertIn("succeeded by Bitwuzla", news)
        entry = next(entry for entry in self.catalog["solvers"] if entry["id"] == "boolector")
        self.assertTrue(entry["deprecated"])
        self.assertIn("maintenance-ended", entry["blockers"])

    def test_dispatch_extractor_rejects_dynamic_or_unknown_choice_shapes(self):
        for text in ['if self.solver == make_name(): pass', 'if self.solver in 3: pass',
                     'if self.solver == 3: pass', 'if self.solver == "a" == "b": pass',
                     'if self.solver.startswith("new"): pass', 'if "new" == self.solver: pass',
                     'if enabled and self.solver.startswith("new"): pass']:
            with self.subTest(text=text), self.assertRaises((ValueError, TypeError)):
                dispatch(ast.parse(text), "self.solver")

    def test_dispatch_extractor_finds_choices_inside_boolean_conditions(self):
        for text in ['if self.solver == "new" and enabled: pass',
                     'if enabled and self.solver == "new": pass',
                     'if self.solver == "new" or self.solver in ["new"]: pass']:
            with self.subTest(text=text):
                self.assertEqual(dispatch(ast.parse(text), "self.solver"), {"new"})


if __name__ == "__main__":
    unittest.main()
