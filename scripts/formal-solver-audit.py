"""Audit pinned solver process boundaries without interpreting SMT responses."""

import math


SOLVERS = {
    "yices2": (["yices-smt2", "--incremental"], [0]),
    "z3": (["z3", "-smt2", "-in"], [0]),
    "bitwuzla": (["bitwuzla", "--lang", "smt2"], [0]),
    "boolector": (["boolector", "--smt2", "-i"], [0, 10, 20]),
}


def require(condition, detail):
    if not condition:
        raise ValueError(detail)


def select(solvers):
    require(type(solvers) in [tuple, list] and solvers and all(type(name) is str and name in SOLVERS for name in solvers), "solver selection")
    require(len(set(solvers)) == len(solvers), "duplicate solver selection")
    return tuple(solvers)


def positive(value):
    return type(value) in [int, float] and math.isfinite(value) and value > 0


def audit_children(children, solver, sha256, case, phase):
    argv, policy = SOLVERS[solver]
    satisfiable = case in ["bmc-violation", "cover-reached"] or (case == "prove-inconclusive" and phase == "induction")
    commands = [(["bitwuzla", "--help"], 0)] if solver == "bitwuzla" else []
    commands.append((argv, (10 if satisfiable else 20) if solver == "boolector" else 0))
    require(type(children) is list and len(children) == len(commands), "solver child count")
    identities = set()
    for child, (args, code) in zip(children, commands, strict=True):
        require(child["args"] == args and child["sha256"] == sha256, "executed solver identity or argv")
        require(child["status"] == "exited" and child["integrityVerified"] is True and child["error"] is None, "solver termination")
        require(type(child["exitCode"]) is int and child["exitCode"] == code, "solver actual exit code")
        declared = child.get("exitCodes", [0])
        require(type(declared) is list and all(type(value) is int for value in declared) and declared == policy, "solver exit policy")
        require(positive(child["elapsedMs"]) and type(child["memoryBytes"]) is int and child["memoryBytes"] > 0, "solver resources")
        require(type(child["stdoutBytes"]) is int and child["stdoutBytes"] > 0 and type(child["stderrBytes"]) is int and child["stderrBytes"] == 0, "solver output")
        for name in ["processId", "jobId"]:
            require(type(child[name]) is str and child[name] and (name, child[name]) not in identities, "solver process identity")
            identities.add((name, child[name]))
