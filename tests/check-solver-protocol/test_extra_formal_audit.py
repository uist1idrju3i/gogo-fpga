import copy
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location("extra_solver_audit", Path(__file__).resolve().parents[2] / "scripts/formal-solver-audit.py")
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class ExtraSolverAuditTest(unittest.TestCase):
    def children(self, solver, case="bmc-prefix", phase="bmc"):
        commands = [(["bitwuzla", "--help"], 0)] if solver == "bitwuzla" else []
        sat = case in ["bmc-violation", "cover-reached"] or (case == "prove-inconclusive" and phase == "induction")
        commands.append((AUDIT.SOLVERS[solver][0], (10 if sat else 20) if solver == "boolector" else 0))
        return [{"args": args, "exitCode": code, "exitCodes": list(AUDIT.SOLVERS[solver][1]), "sha256": "1" * 64,
                 "status": "exited", "integrityVerified": True, "error": None, "elapsedMs": 1.25, "memoryBytes": 65536,
                 "stdoutBytes": 100, "stderrBytes": 0, "jobId": f"job-{n}", "processId": f"process-{n}"}
                for n, (args, code) in enumerate(commands)]

    def test_each_upstream_fixture_phase_and_actual_solver_code(self):
        for solver in ["bitwuzla", "boolector"]:
            for case in ["bmc-prefix", "bmc-violation", "prove-inconclusive", "prove-invariant", "cover-reached", "cover-unreached"]:
                for phase in (["basecase", "induction"] if case.startswith("prove") else ["bmc"]):
                    with self.subTest(solver=solver, case=case, phase=phase):
                        AUDIT.audit_children(self.children(solver, case, phase), solver, "1" * 64, case, phase)

    def test_each_transport_field_rejects_inconsistent_success(self):
        mutations = {"args": ["z3"], "exitCode": 9, "exitCodes": [0, 9], "sha256": "2" * 64,
                     "status": "runtime-error", "integrityVerified": False, "error": "failed", "elapsedMs": 0,
                     "memoryBytes": 0, "stdoutBytes": 0, "stderrBytes": 5, "jobId": "", "processId": ""}
        for solver in ["bitwuzla", "boolector"]:
            for field, value in mutations.items():
                with self.subTest(solver=solver, field=field):
                    children = self.children(solver)
                    children[-1][field] = value
                    with self.assertRaises(ValueError):
                        AUDIT.audit_children(children, solver, "1" * 64, "bmc-prefix", "bmc")

    def test_bitwuzla_requires_real_distinct_help_and_solver_children(self):
        children = self.children("bitwuzla")
        for altered in [children[1:], children[:1], children[::-1], children + children, [children[0], children[0]]]:
            with self.subTest(altered=altered), self.assertRaises(ValueError):
                AUDIT.audit_children(altered, "bitwuzla", "1" * 64, "bmc-prefix", "bmc")

    def test_bool_and_nonfinite_cannot_impersonate_process_values(self):
        for solver in ["bitwuzla", "boolector"]:
            for field, values in {"exitCode": [False, True], "exitCodes": [[False], [False, 10, 20]],
                                  "elapsedMs": [True, float("inf"), float("nan")], "stdoutBytes": [True, 0.5],
                                  "stderrBytes": [False], "memoryBytes": [True, float("inf")]}.items():
                for value in values:
                    children = copy.deepcopy(self.children(solver))
                    children[-1][field] = value
                    with self.subTest(solver=solver, field=field, value=value), self.assertRaises(ValueError):
                        AUDIT.audit_children(children, solver, "1" * 64, "bmc-prefix", "bmc")

    def test_explicit_selection_does_not_weaken_default_solver_set(self):
        self.assertEqual(AUDIT.select(["bitwuzla", "boolector"]), ("bitwuzla", "boolector"))
        for value in [[], None, "bitwuzla", ["bitwuzla", "bitwuzla"], ["unknown"], [True], [None]]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                AUDIT.select(value)
