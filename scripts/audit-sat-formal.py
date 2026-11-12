#!/usr/bin/env python3
"""Yosys SAT 形式検証 probe の出力を、保存ログから独立に再判定して監査する。"""

import argparse
import hashlib
import json
import math
from pathlib import Path
import re
import sys


# probe 側の tests/synth/formal-sat-cases.mjs とは独立に書いた期待値。
CASES = {
    "identity": ("bmc", 8, "bounded-safe"),
    "broken-identity": ("bmc", 8, "counterexample"),
    "depth3": ("bmc", 3, "bounded-safe"),
    "depth4": ("bmc", 4, "counterexample"),
    "depth5": ("bmc", 5, "counterexample"),
    "induction": ("prove", 8, "proved"),
    "false-induction": ("prove", 8, "counterexample"),
    "contradictory-assumes": ("bmc", 8, "inconsistent-assumptions"),
}
# 不正入力の条件。正常系には混ぜず、error と失敗段階・exit code を固定する。
ERROR_CASES = {
    "zero-properties": ("bmc", 8, "prepare", 0, "No assertion targets in formal design"),
    "wrong-clock": ("bmc", 8, "prepare", 0, "Formal clock must be a single-bit input port"),
    "wrong-edge": ("bmc", 8, "prepare", 0, "Formal clock does not match every register"),
    "unsupported-syntax": ("bmc", 8, "prepare", 1, "Formal preparation failed"),
}
RUNTIMES = ("native", "wasm")
ORDERS = {"native-first": ["native", "wasm"], "wasm-first": ["wasm", "native"]}
COLUMNS = ["case", "mode", "depth", "runtime", "runtimeIndex", "expected", "actual", "exitCode", "elapsedMs",
           "wasmMemoryBytes", "distributionBytes", "sourceSha256", "phases", "logSha256"]
REPLAY_COLUMNS = ["case", "runtime", "replayStatus", "replayNative", "replayWasm", "negativeStatus",
                  "witnessSha256", "replaySha256", "replayVcdSha256"]
HEX = re.compile(r"[0-9a-f]{64}")


class AuditError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def strict_json(raw):
    def pairs(items):
        keys = [key for key, _ in items]
        require(len(keys) == len(set(keys)), "duplicate JSON key")
        return dict(items)

    def constant(name):
        raise AuditError("non-finite JSON constant: " + name)

    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def integer(value):
    return type(value) is int


def positive(value):
    return integer(value) and value > 0


class Evidence:
    def __init__(self, directory):
        self.root = Path(directory).resolve(strict=True)
        require(self.root.is_dir() and not Path(directory).is_symlink(), "evidence directory")

    def path(self, name):
        target = (self.root / name).resolve()
        require(target.is_relative_to(self.root), "unsafe evidence path: " + name)
        return target

    def read(self, name):
        target = self.path(name)
        require(target.is_file() and not target.is_symlink(), "missing evidence file: " + name)
        return target.read_bytes()

    def data(self, name):
        return strict_json(self.read(name))


def count(text, pattern):
    return len(re.findall(pattern, text, flags=re.M))


def classify(evidence, case, runtime, mode):
    """formal-sat.mjs と同じ規則で、保存した stdout/stderr だけから判定を出し直す。"""
    def log(phase):
        name = f"{case}/{runtime}-{phase}"
        return evidence.read(name + ".stdout").decode() + "\n" + evidence.read(name + ".stderr").decode()

    presat = log("presat")
    has_model = count(presat, r"^SAT solving finished - model found:\s*$")
    no_model = count(presat, r"^SAT solving finished - no model found\.\s*$")
    if has_model == 0 and no_model == 1:
        require(not evidence.path(f"{case}/{runtime}-proof.stdout").exists(), "proof after inconsistent assumptions")
        return "inconsistent-assumptions"
    require(has_model == 1 and no_model == 0, "ambiguous assumption result: " + case)
    proof = log("proof")
    bounded = count(proof, r"^SAT proof finished - no model found: SUCCESS!\s*$")
    inductive = count(proof, r"^Induction step proven: SUCCESS!\s*$")
    base = count(proof, r"^Base case for induction length \d+ proven\.\s*$")
    violation = count(proof, r"^SAT (?:temporal induction )?proof finished - model found(?: for base case)?: FAIL!\s*$")
    if violation == 1 and bounded == 0 and inductive == 0:
        return "counterexample"
    require(violation == 0, "ambiguous violation: " + case)
    if mode == "bmc" and bounded == 1 and inductive == 0:
        return "bounded-safe"
    if mode == "prove" and inductive == 1 and base > 0 and bounded == 0:
        return "proved"
    raise AuditError("unclassifiable proof log: " + case)


def tree_hash(evidence, case):
    base = evidence.path(case)
    entries = sorted((path for path in base.rglob("*") if path.is_file() and not path.name.endswith(".vcd")
                      and not any(part.endswith("-replay") for part in path.relative_to(base).parts[:-1])), key=str)
    require(all(not path.is_symlink() for path in entries), "symlink in case logs: " + case)
    listing = [[path.relative_to(evidence.root).as_posix(), digest(path.read_bytes())] for path in entries]
    return digest(json.dumps(listing, separators=(",", ":"), ensure_ascii=False).encode())


def normalized_vcd(raw):
    text = raw.decode()
    found = re.findall(r"\$date\s+[^$]+\$end", text)
    require(len(found) == 1, "one replay VCD date")
    return text.replace(found[0], "$date RECORDED $end", 1).encode()


def audit_errors(evidence, meta, result):
    order = ORDERS[meta["order"]]
    rows, failures = result["rows"], result["failures"]
    require(isinstance(rows, list) and len(rows) == len(ERROR_CASES) * len(RUNTIMES), "error row count")
    require(result["replays"] == [] and isinstance(failures, list) and len(failures) == len(rows), "error records")
    for index, (row, failure) in enumerate(zip(rows, failures)):
        require(isinstance(row, dict) and list(row) == COLUMNS, "error row columns")
        case, runtime = row["case"], row["runtime"]
        require(case in ERROR_CASES and runtime in RUNTIMES, "error row identity")
        mode, depth, phase, exit_code, message = ERROR_CASES[case]
        require(index == list(ERROR_CASES).index(case) * 2 + order.index(runtime), "error row order")
        require(row["mode"] == mode and row["depth"] == depth and row["runtimeIndex"] == order.index(runtime), "error mode/depth")
        require(row["expected"] == "error" and row["actual"] == "error" and row["exitCode"] == exit_code, "error verdict: " + case)
        require(positive(row["elapsedMs"]), "error elapsed time")
        require(row["sourceSha256"] == digest(evidence.read(f"{case}/native/top.v")), "error source hash")
        require(row["logSha256"] == tree_hash(evidence, case), "error log hash: " + case)
        require([item["phase"] for item in row["phases"]] == [phase], "error phase sequence: " + case)
        require(list(failure) == ["case", "runtime", "phase", "message"] and failure["case"] == case
                and failure["runtime"] == runtime and failure["phase"] == phase
                and failure["message"] == message, "error failure record: " + case)
        require(not evidence.path(f"{case}/{runtime}-presat.stdout").exists(), "no SAT run after error: " + case)
    require({path.name for path in evidence.root.iterdir()} == {"metadata.json", "results.json", *ERROR_CASES}, "unexpected error entries")
    return {"status": "pass", "commit": meta["commit"], "order": meta["order"], "kind": "error", "rows": len(rows), "replays": 0}


def audit(directory):
    evidence = Evidence(directory)
    meta = evidence.data("metadata.json")
    require(meta.get("kind") == "sat-formal-probe-v1" and integer(meta.get("format")) and meta["format"] == 1, "probe metadata kind")
    require(isinstance(meta.get("commit"), str) and re.fullmatch(r"[0-9a-f]{40}", meta["commit"]) and meta.get("worktree") == "", "clean probe commit")
    kind = meta.get("caseKind")
    require(kind in {"verdict", "error"}, "probe case kind")
    table = CASES if kind == "verdict" else ERROR_CASES
    require(meta.get("order") in ORDERS and meta.get("cases") == list(table), "probe matrix")
    for runtime in RUNTIMES:
        binary = meta["binaries"]["yosys-" + runtime]
        require(HEX.fullmatch(binary["sha256"]) and positive(binary["bytes"]), "yosys binary identity: " + runtime)
    result = evidence.data("results.json")
    require(result.get("kind") == "sat-formal-probe-result-v1" and integer(result.get("format")) and result["format"] == 1, "probe result kind")
    require(result.get("order") == meta["order"] and result.get("caseKind") == kind and result.get("cases") == meta["cases"], "probe result header")
    if kind == "error":
        return audit_errors(evidence, meta, result)
    order = ORDERS[meta["order"]]
    rows = result["rows"]
    require(isinstance(rows, list) and len(rows) == len(CASES) * len(RUNTIMES), "probe row count")
    seen = set()
    counterexamples = []
    for index, row in enumerate(rows):
        require(isinstance(row, dict) and list(row) == COLUMNS, "probe row columns")
        case, runtime = row["case"], row["runtime"]
        require(case in CASES and runtime in RUNTIMES and (case, runtime) not in seen, "unique probe row")
        seen.add((case, runtime))
        mode, depth, expected = CASES[case]
        require(index == list(CASES).index(case) * 2 + order.index(runtime), "probe row order")
        require(row["mode"] == mode and integer(row["depth"]) and row["depth"] == depth, "probe mode/depth: " + case)
        require(row["runtimeIndex"] == order.index(runtime), "runtime alternation index")
        require(row["expected"] == expected and row["actual"] == expected, "expected verdict: " + case)
        require(classify(evidence, case, runtime, mode) == expected, "independent verdict: " + case)
        require(integer(row["exitCode"]) and row["exitCode"] == (1 if expected == "counterexample" else 0), "exit code: " + case)
        require(positive(row["elapsedMs"]) and math.isfinite(row["elapsedMs"]), "elapsed time: " + case)
        if runtime == "wasm":
            require(positive(row["wasmMemoryBytes"]) and row["wasmMemoryBytes"] % 65536 == 0, "WASM memory: " + case)
        else:
            require(row["wasmMemoryBytes"] is None, "native has no WASM memory")
        require(row["distributionBytes"] == meta["binaries"]["yosys-" + runtime]["bytes"], "distribution bytes")
        require(row["sourceSha256"] == digest(evidence.read(f"{case}/native/top.v")), "source hash: " + case)
        phases = row["phases"]
        names = ["prepare", "presat"] + ([] if expected == "inconsistent-assumptions" else ["proof"])
        require([phase["phase"] for phase in phases] == names, "phase sequence: " + case)
        for phase in phases:
            require(list(phase) == ["phase", "exitCode", "memoryBytes"] and integer(phase["exitCode"]), "phase record")
            require(phase["exitCode"] == (1 if expected == "counterexample" and phase["phase"] == "proof" else 0), "phase exit")
            require((positive(phase["memoryBytes"]) if runtime == "wasm" else phase["memoryBytes"] is None), "phase memory")
            evidence.read(f"{case}/{runtime}-{phase['phase']}.ys")
        require(row["wasmMemoryBytes"] == (max(phase["memoryBytes"] for phase in phases) if runtime == "wasm" else None), "peak WASM memory")
        require(row["logSha256"] == tree_hash(evidence, case), "log tree hash: " + case)
        if expected == "counterexample":
            counterexamples.append((case, runtime))
    require(result["failures"] == [], "no failures in verdict probe")
    replays = result["replays"]
    require(isinstance(replays, list) and [(item.get("case"), item.get("runtime")) for item in replays] == counterexamples, "replay coverage")
    for item in replays:
        require(list(item) == REPLAY_COLUMNS, "replay columns")
        case, runtime = item["case"], item["runtime"]
        prefix = f"{case}/{runtime}-replay/"
        require(item["replayStatus"] == "verified" and item["negativeStatus"] == "rejected", "replay status: " + case)
        native, wasm = item["replayNative"], item["replayWasm"]
        require(native == wasm and native["status"] == "verified" and positive(native["steps"]), "native/WASM replay agreement")
        require(native["steps"] == CASES[case][1] or CASES[case][0] == "prove", "replay steps: " + case)
        witness = evidence.data(prefix + "witness.json")
        compact = json.dumps(witness, separators=(",", ":"), ensure_ascii=False).encode()
        require(item["witnessSha256"] == digest(compact), "witness hash: " + case)
        require(item["replaySha256"] == digest(evidence.read(prefix + "replay.v")), "replay script hash: " + case)
        require(item["replayVcdSha256"] == digest(normalized_vcd(evidence.read(prefix + "wasm-replay.vcd"))), "replay VCD hash: " + case)
        execution = evidence.data(prefix + "wasm-execution.json")
        require(execution["status"] == 0 and execution["stderr"] == "", "WASM replay execution: " + case)
        require(evidence.read(prefix + "vvp.stderr") == b"", "native replay diagnostics: " + case)
        negative = evidence.data(prefix + "negative-result.json")
        require(integer(negative["status"]), "negative replay result: " + case)
        require(evidence.read(prefix + "negative-witness.json") != evidence.read(prefix + "witness.json"), "negative witness changed")
    allowed = {"metadata.json", "results.json", *CASES}
    require({path.name for path in evidence.root.iterdir()} == allowed, "unexpected probe entries")
    return {"status": "pass", "commit": meta["commit"], "order": meta["order"], "kind": "verdict", "rows": len(rows), "replays": len(replays)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(audit(args.directory), sort_keys=True))
    except (AuditError, KeyError, TypeError, ValueError, OSError) as error:
        print("audit failed: " + str(error), file=sys.stderr)
        sys.exit(1)
