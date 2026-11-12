#!/usr/bin/env python3
"""SMTBMCの記録境界を、元の成果物とCSV全列から独立に照合する。"""

import argparse
import ast
import csv
import importlib.util
import io
import json
import math
from pathlib import Path, PurePosixPath
import re


SPEC = importlib.util.spec_from_file_location("trace_sby_audit", Path(__file__).with_name("audit-formal-sby.py"))
SBY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SBY)
require, digest, positive, SOLVERS = SBY.require, SBY.digest, SBY.positive, SBY.SOLVERS
COLUMNS = "solver case phase runtime entrypoint status exitCode expectedTrace traceCount elapsedMs modelSha256 solverSha256 stdoutSha256 stderrSha256 captureSha256 artifactsSha256 error".split()
MAX_BYTES = 8 * 1024 * 1024


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))


def audit_resolved_native(probe):
    resolved = PurePosixPath(probe["command"]["resolvedPath"])
    name = probe["native"]["artifact"]["path"]
    artifact = PurePosixPath(name)
    require(name and str(artifact) == name and not artifact.is_absolute() and ".." not in artifact.parts
            and "\\" not in name and "\0" not in name and not re.match(r"^[A-Za-z]:", name), "native artifact path")
    require(resolved.is_absolute() and resolved.parts[-len(artifact.parts):] == artifact.parts, "resolved native artifact path")


class Evidence(SBY.Evidence):
    def __init__(self, directory):
        path = Path(directory).absolute()
        require(not any(parent.is_symlink() for parent in [path, *path.parents]), "symlink evidence root")
        super().__init__(directory)

    def path(self, name):
        require(type(name) is str and name and not any(char in name for char in "\\\0:"), "invalid evidence path")
        require(PurePosixPath(name).parts and name != ".", "empty evidence path")
        return super().path(name)

    def data(self, name):
        value = super().data(name)
        encoded(value)
        return value


def net_path(value):
    require(type(value) is list and 0 < len(value) <= 64
            and all(type(part) is str and 0 < len(part) <= 512 and "\0" not in part for part in value), "invalid captured signal path")
    return tuple(value)


def original_writer():
    source = Path(__file__).resolve().parents[1] / "vendor/yosys/backends/smt2/smtio.py"
    tree = ast.parse(source.read_bytes())
    classes = [node for node in tree.body if isinstance(node, ast.ClassDef) and node.name == "MkVcd"]
    require(len(classes) == 1, "original MkVcd source")
    namespace = {"re": re}
    exec(compile(ast.Module(body=classes, type_ignores=[]), str(source), "exec"), namespace)
    return namespace["MkVcd"]


def capture(evidence, prefix, expected_code, model_sha, expected_trace):
    raw = evidence.read(prefix + "formal-trace.json")
    require(len(raw) <= MAX_BYTES, "capture JSON limit")
    item = evidence.data(prefix + "formal-trace.json")
    require(type(item) is dict and set(item) == {"format_version", "upstreamExitCode", "model", "traces"}, "capture schema")
    require(type(item["format_version"]) is int and item["format_version"] == 1, "capture format")
    require(type(item["upstreamExitCode"]) is int and item["upstreamExitCode"] == expected_code, "capture exit code")
    require(item["model"] == {"path": "model.smt2", "sha256": model_sha}, "capture model identity")
    traces = item["traces"]
    require(type(traces) is list and len(traces) == int(expected_trace), "capture trace inventory")
    for trace in traces:
        require(set(trace) == {"path", "sha256", "signals", "steps", "endTime"} and trace["path"] == "trace.vcd", "capture trace schema")
        vcd = evidence.read(prefix + trace["path"])
        require(len(vcd) <= MAX_BYTES and digest(vcd) == trace["sha256"], "capture VCD hash")
        stream = io.StringIO()
        writer = original_writer()(stream)
        widths = {}
        signals = trace["signals"]
        require(type(signals) is list and 0 < len(signals) <= 4096, "capture signal inventory")
        for signal in signals:
            require(set(signal) == {"path", "width", "clock"}, "capture signal schema")
            path = net_path(signal["path"])
            width, edge = signal["width"], signal["clock"]
            require(path not in widths and type(width) is int and 0 < width <= 4096, "duplicate signal or invalid width")
            widths[path] = width
            if edge is None:
                writer.add_net(path, width)
            else:
                require(type(edge) is str and edge in {"posedge", "negedge", "event"} and width == 1, "invalid captured clock")
                writer.add_clock(path, edge)
        steps = trace["steps"]
        require(type(steps) is list and 0 < len(steps) <= 1024, "capture sample inventory")
        require(type(trace["endTime"]) is int and trace["endTime"] == len(steps), "capture terminal step")
        for time, step in enumerate(steps):
            require(set(step) == {"time", "values"} and type(step["time"]) is int and step["time"] == time, "capture step sequence")
            writer.set_time(time)
            values = step["values"]
            require(type(values) is list and len(values) == len(widths), "capture complete signal samples")
            seen = set()
            for value in values:
                require(set(value) == {"path", "bits"}, "capture value schema")
                path = net_path(value["path"])
                require(path in widths and path not in seen, "duplicate or unknown captured sample")
                seen.add(path)
                bits = value["bits"]
                require(type(bits) is str and len(bits) == widths[path] and set(bits) <= {"0", "1"}, "captured sample bits")
                writer.set_net(path, bits)
        writer.set_time(trace["endTime"])
        require(stream.getvalue().encode() == vcd, "captured values or clocks disagree with original VCD")
    return digest(raw), len(traces)


def audit(directory, solvers=("yices2", "z3"), formal=False):
    solvers = SOLVERS.select(solvers)
    evidence = Evidence(directory)
    meta, result = evidence.data("metadata.json"), evidence.data("results.json")
    require(type(meta["format"]) is int and meta["format"] == 1 and type(meta["preliminary"]) is bool, "evidence mode")
    require(type(result["preliminary"]) is bool and result["preliminary"] is meta["preliminary"], "matching result mode")
    formal = formal or not meta["preliminary"]
    require(meta.get("artifactOrder") in [None, "codepoint"], "artifact hash ordering")
    require(not formal or meta.get("artifactOrder") == "codepoint", "formal deterministic artifact ordering")
    require(re.fullmatch(r"[a-f0-9]{40}", meta["commit"]) is not None, "harness commit")
    require(not formal or (meta["preliminary"] is False and meta["worktree"] == ""), "clean formal trace harness")
    for name in ["node", "python", "pyodide", "submodules"]:
        require(type(meta[name]) is str and meta[name], "runtime identity: " + name)
    for name in ["cpus", "memoryBytes"]:
        require(type(meta["host"][name]) is int and meta["host"][name] > 0, "host identity")
    for name in ["scripts/probe-formal-trace.mjs", "scripts/build-formal-python.py", "web/formal_trace.py",
                 "tests/synth/formal-sby-cases.mjs", "tests/synth/solver-protocol-helpers.mjs"]:
        require(name in meta["snapshots"], "missing boundary source snapshot")
    for name, sha in meta["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha, "source snapshot hash: " + name)
    require(evidence.data("assets/manifest.json") == meta["sources"], "source manifest")
    assets = meta["sources"]["assets"]
    require(len(assets) == len({asset["path"] for asset in assets}) and assets, "duplicate source asset")
    for asset in assets:
        raw = evidence.read("assets/" + asset["path"])
        require(type(asset["size"]) is int and len(raw) == asset["size"] and digest(raw) == asset["sha256"], "asset byte identity")
    require(evidence.read("assets/formal_trace.py") == evidence.read("snapshots/web/formal_trace.py"), "staged capture adapter identity")
    baseline = evidence.data("baseline-metadata.json")
    require(digest(evidence.read("baseline-metadata.json")) == meta["baselineSha256"]
            and digest(evidence.read("baseline-results.json")) == meta["baselineResultsSha256"], "native baseline hashes")
    if formal:
        require(baseline["preliminary"] is False and baseline["worktree"] == "" and baseline["commit"] == meta["commit"], "clean matching native baseline")
        for name, sha in baseline["sources"].items():
            require(meta["snapshots"][name] == sha, "matching native source bytes")
        pins = {name: sha for sha, name in re.findall(r"^160000 commit ([a-f0-9]{40})\tvendor/(\w+)$", baseline["pins"], re.M)}
        require(pins == meta["sources"]["pins"], "matching native and staged source pins")
        for origin in meta["sources"]["origins"].values():
            name = "vendor/" + origin["submodule"] + "/" + origin["source"]
            require(origin["original_sha256"] == meta["snapshots"][name], "asset original source provenance")
        for name, sha in meta["sources"]["patches"].items():
            require(meta["snapshots"]["patches/" + name] == sha, "staged process patch provenance")
    references = evidence.data("baseline-results.json")["rows"]
    require(set(meta["probes"]) == set(solvers), "selected solver inventory")
    for solver, probe in meta["probes"].items():
        executable = SOLVERS.SOLVERS[solver][0][0]
        require(type(probe["version"]) is str and probe["version"], "actual solver version")
        for runtime in ["native", "wasi"]:
            build = evidence.data(solver + "-" + runtime + "-build.json")
            require(encoded(build) == encoded(probe[runtime]), "solver build snapshot")
            require(build["status"] == "built" and build["worktree_status"] == "", "clean successful solver build")
            require(re.fullmatch(r"[0-9a-f]{64}", build["artifact"]["sha256"]) is not None, "solver binary hash")
            if formal:
                require(digest(evidence.read("inputs/" + solver + ("-native" if runtime == "native" else ".wasm"))) == build["artifact"]["sha256"], "executed solver binary bytes")
                require(build["solver"] == solver and build["runtime"] == runtime and build["source"]["commit"] == meta["sourcePins"][solver], "pinned solver source identity")
                require(digest(evidence.read("inputs/" + solver + "-" + runtime + "-build.py")) == build["script_sha256"], "solver build script identity")
                for patch in build["patches"]:
                    require(meta["snapshots"][patch["path"]] == patch["sha256"], "solver patch identity")
        require(probe["native"]["source"] == probe["wasi"]["source"], "matching solver source")
        for command in [probe["command"], baseline["solverCommands"][solver]]:
            require(PurePosixPath(command["path"]).is_absolute() and PurePosixPath(command["path"]).name == executable
                    and command["sha256"] == probe["native"]["artifact"]["sha256"], "native command identity")
        if formal:
            audit_resolved_native(probe)
    require(result["columns"] == COLUMNS, "JSON columns")
    reader = csv.DictReader(io.StringIO(evidence.read("results.csv").decode()), strict=True)
    require(reader.fieldnames == COLUMNS, "CSV columns")
    csv_rows, rows = list(reader), result["rows"]
    expected_identities = {(solver, case, phase, runtime, entrypoint)
                           for solver in solvers for case, (mode, *_) in SBY.CASES.items()
                           for phase in (["basecase", "induction"] if mode == "prove" else [mode])
                           for runtime in ["native", "pyodide"] for entrypoint in ["smtbmc", "formal_trace"]}
    require(len(rows) == len(csv_rows) == len(expected_identities), "complete trace row count")
    seen, plain, captured = set(), {}, {}
    for row, csv_row in zip(rows, csv_rows, strict=True):
        if not formal and row.get("entrypoint") == "smtbmc" and "captureSha256" not in row:
            row = {**row, "captureSha256": None}
        require(set(row) == set(COLUMNS), "complete JSON row columns")
        identity = tuple(row[name] for name in COLUMNS[:5])
        require(identity in expected_identities and identity not in seen, "unknown or duplicated trace condition")
        seen.add(identity)
        solver, case, phase, runtime, entrypoint = identity
        group = identity[:3]
        label = "-".join(group) + "/" + runtime + "-" + entrypoint + "/"
        trace = case in ["bmc-violation", "cover-reached"] or (case == "prove-inconclusive" and phase == "induction")
        code = int(case in ["bmc-violation", "cover-unreached"] or (case == "prove-inconclusive" and phase == "induction"))
        state = evidence.data(label + "process.json")
        require(state["status"] == "exited" and type(state["exitCode"]) is int and state["exitCode"] == code and positive(state["elapsedMs"]), "SMTBMC termination")
        expected_args = ["-s", "yices" if solver == "yices2" else solver, "--presat", "--noprogress"]
        expected_args += (["--unroll"] if solver == "yices2" else []) + (["-i"] if phase == "induction" else ["-c"] if phase == "cover" else [])
        expected_args += ["-t", str(SBY.CASES[case][1]), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"]
        require(state["args"] == expected_args, "SMTBMC argument identity")
        build_runtime = "native" if runtime == "native" else "wasi"
        solver_sha = meta["probes"][solver][build_runtime]["artifact"]["sha256"]
        if runtime == "native":
            require(state["error"] is None and state["signal"] is None, "native Python termination")
        else:
            require(state["type"] == "exit" and state["integrityVerified"] is True and type(state["jobId"]) is str and state["jobId"], "Python transport integrity")
            SOLVERS.audit_children(state["children"], solver, solver_sha, case, phase)
            require([child["processId"] for child in state["children"]] == [state["jobId"] + ":" + str(n + 1) for n in range(len(state["children"]))], "child parent identity")
        prefix = label + "files/"
        names = ["model.smt2", "top.v"] + (["trace.vcd", "trace.yw", "trace_tb.v"] if trace else [])
        require(evidence.files(label + "files") == set(names + (["formal-trace.json"] if entrypoint == "formal_trace" else [])), "artifact inventory")
        ordered = sorted(names) if meta.get("artifactOrder") == "codepoint" else [name for name in
                  ["model.smt2", "top.v", "trace_tb.v", "trace.vcd", "trace.yw"] if name in names]
        files = {name: digest(evidence.read(prefix + name)) for name in ordered}
        reference = [item for item in references if item["solver"] == solver and item["case"] == case]
        require(len(reference) == 1 and reference[0]["error"] is None and reference[0]["files"]["result/model/design_smt2.smt2"]["sha256"] == files["model.smt2"], "native model provenance")
        require(reference[0]["files"]["top.v"]["sha256"] == files["top.v"], "original HDL identity")
        stdout, stderr = evidence.read(label + "stdout.log"), evidence.read(label + "stderr.log")
        normalized = re.sub(rb"^##\s+\d+:\d\d:\d\d\s+", b"## TIME ", stdout, flags=re.M)
        require(stdout.endswith(b"Status: " + (b"FAILED" if code else b"PASSED") + b"\n") and stderr == b"", "SMTBMC status and streams")
        semantic = (normalized, stderr, files)
        plain.setdefault(group, semantic)
        require(semantic == plain[group], "original and captured artifacts or streams differ")
        capture_sha, count = capture(evidence, prefix, code, files["model.smt2"], trace) if entrypoint == "formal_trace" else (None, 0)
        if entrypoint == "formal_trace":
            captured.setdefault(group, capture_sha)
            require(captured[group] == capture_sha, "native and Pyodide capture bytes differ")
        derived = dict(zip(COLUMNS[:5], identity))
        derived.update(status="matched", exitCode=code, expectedTrace=trace, traceCount=count, elapsedMs=state["elapsedMs"],
                       modelSha256=files["model.smt2"], solverSha256=solver_sha, stdoutSha256=digest(stdout), stderrSha256=digest(stderr),
                       captureSha256=capture_sha, artifactsSha256=digest(json.dumps(files, separators=(",", ":")).encode()), error=None)
        require(encoded(derived) == encoded(row), "JSON cells disagree with raw evidence")
        for name in COLUMNS:
            value = derived[name]
            if name == "elapsedMs":
                require(positive(float(csv_row[name])) and float(csv_row[name]) == value, "CSV elapsed time")
            else:
                text = "" if value is None else str(value).lower() if type(value) is bool else str(value)
                require(csv_row[name] == text, "CSV cell disagrees with raw evidence: " + name)
    require(seen == expected_identities, "unique complete trace conditions")
    return {"status": "pass", "preliminary": meta["preliminary"], "commit": meta["commit"], "rows": len(rows), "columns": len(COLUMNS)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--solver", action="append", choices=SOLVERS.SOLVERS)
    parser.add_argument("--formal", action="store_true")
    args = parser.parse_args()
    print(json.dumps(audit(args.directory, args.solver if args.solver is not None else ("yices2", "z3"), args.formal), sort_keys=True))
