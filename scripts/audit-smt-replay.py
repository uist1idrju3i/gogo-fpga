#!/usr/bin/env python3
"""SMTの記録と独立したVCD・診断から、元Verilog再実行の全列を照合する。"""

import argparse
import bisect
import csv
import importlib.util
import io
import json
from pathlib import Path
import re


SPEC = importlib.util.spec_from_file_location("smt_trace_audit", Path(__file__).with_name("audit-formal-trace.py"))
TRACE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TRACE)
require, digest, Evidence = TRACE.require, TRACE.digest, TRACE.Evidence
COLUMNS = "solver case origin runtime phase expected actual exitCode elapsedMs steps failures sourceSha256 modelSha256 captureSha256 sourceVcdSha256 designSha256 replaySha256 stdoutSha256 stderrSha256 vcdSha256 error".split()
CASES = "depth-n-minus-1 depth-n depth-n-plus-1 prove-basecase negedge nonzero-initial combinational reset assumption multiple-properties hierarchy arbitrary-initial unknown-initial memory no-property vacuous-assumption combinational-loop".split()
REJECTED = {
    "depth-n-minus-1": "SMT replay requires one complete failing assertion trace",
    "arbitrary-initial": "Replay of unconstrained initial state is unsupported",
    "unknown-initial": "Replay requires concrete register initialization",
    "memory": "Unsupported formal state cell: $memwr_v2",
    "no-property": "No assertion targets in formal design",
    "vacuous-assumption": "SMT replay requires one complete failing assertion trace",
}
DEPTHS = {"depth-n-minus-1": 4, "depth-n": 5, "combinational": 3, "no-property": 3, "vacuous-assumption": 3, "combinational-loop": 3}


def compact(item):
    return json.dumps(item, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


def initialized_state(module):
    initialized = {}
    for net in module["netnames"].values():
        if "init" not in net.get("attributes", {}):
            continue
        value = net["attributes"]["init"]
        require(type(value) is str and len(value) == len(net["bits"]) and set(value) <= {"0", "1"}, "concrete original initialization")
        for bit, digit in zip(net["bits"], reversed(value), strict=True):
            require(bit not in initialized or initialized[bit] == digit, "consistent original initialization")
            initialized[bit] = digit
    for cell in module["cells"].values():
        require(cell["type"] == "$dff" or re.match(r"^\$(?:.*ff|.*latch|mem|anyinit|sr$)", cell["type"], re.I) is None, "supported original state")
        if cell["type"] == "$dff":
            require(all(bit in initialized for bit in cell["connections"]["Q"]), "fully initialized original registers")
    return initialized


def normalize_tb(text):
    def connections(match):
        lines = [line.removesuffix(",") for line in match[2].rstrip("\n").split("\n")]
        if not all(re.fullmatch(r"    \.([A-Za-z_][A-Za-z0-9_$]*)\(PI_\1\)", line) for line in lines):
            return match[0]
        return match[1] + ",\n".join(sorted(lines)) + "\n" + match[3]
    text = re.sub(r"(?:^  (?:reg|wire) \[\d+:\d+\] PI_[A-Za-z0-9_$]+(?: = clock)?;\n)+",
                  lambda match: "\n".join(sorted(match[0].rstrip("\n").split("\n"))) + "\n", text, flags=re.M)
    return re.sub(r"(  top UUT \(\n)((?:    \.[A-Za-z0-9_$]+\(PI_[A-Za-z0-9_$]+\),?\n)+)(  \);)", connections, text)


def waveform(raw):
    text = raw.decode("utf-8", errors="strict")
    header, body = text.split("$enddefinitions $end", 1)
    scale = re.search(r"\$timescale\s+(1|10|100)\s*(s|ms|us|ns|ps|fs)\s+\$end", header)
    require(scale is not None, "replay waveform timescale")
    ticks = 10 ** ({"s": 0, "ms": 3, "us": 6, "ns": 9, "ps": 12, "fs": 15}[scale[2]] - 9) / int(scale[1])
    scope, names, widths = [], {}, {}
    for line in header.splitlines():
        parts = line.split()
        if parts[:1] == ["$scope"]:
            require(len(parts) == 4 and parts[-1] == "$end", "waveform scope")
            scope.append(parts[2])
        elif parts[:1] == ["$upscope"]:
            require(scope and parts == ["$upscope", "$end"], "waveform scope balance")
            scope.pop()
        elif parts[:1] == ["$var"]:
            require(len(parts) >= 6 and parts[-1] == "$end" and parts[2].isdigit(), "waveform declaration")
            width, symbol = int(parts[2]), parts[3]
            name = tuple(scope + [parts[4]])
            require(name not in names and 0 < width <= 4096 and (symbol not in widths or widths[symbol] == width), "waveform signal identity")
            names[name], widths[symbol] = symbol, width
    require(not scope and names, "waveform complete declarations")
    times, states, current, time = [], [], {}, None
    for line in body.splitlines():
        line = line.strip()
        if not line or line in {"$dumpall", "$dumpvars", "$end"}:
            continue
        if line.startswith("$comment ") and line.endswith(" $end"):
            continue
        if re.fullmatch(r"#\d+", line):
            number = int(line[1:])
            require(time is None and number == 0 or time is not None and number > time, "waveform monotonic time")
            if time is not None:
                times.append(time); states.append(dict(current))
            time = number
            continue
        match = re.fullmatch(r"b([01xz]+) (\S+)|([01xz])(\S+)", line)
        require(time is not None and match is not None, "waveform value syntax")
        value, symbol = (match[1], match[2]) if match[1] is not None else (match[3], match[4])
        require(symbol in widths and len(value) <= widths[symbol], "waveform value width")
        current[symbol] = value.rjust(widths[symbol], value[0] if value[0] in "xz" else "0")
    require(time is not None and current, "waveform samples")
    times.append(time); states.append(dict(current))

    def value(name, ns):
        require(tuple(name) in names and times[0] <= ns * ticks <= times[-1], "missing replay observation")
        state = states[bisect.bisect_right(times, ns * ticks) - 1]
        symbol = names[tuple(name)]
        require(symbol in state, "missing replay value")
        return state[symbol]

    return value, times[-1] / ticks, times, states, names


def expected_plan(document, capture, case):
    module = document["modules"]["top"]
    trace = capture["traces"][0]
    clock = None if case == "combinational" else "clk"
    edge = "negedge" if case == "negedge" else "posedge"
    initialized = initialized_state(module)
    require(0 < len(trace["steps"]) <= DEPTHS.get(case, 6), "original trace depth boundary")
    registers = [cell for cell in module["cells"].values() if cell["type"] == "$dff"]
    require(bool(registers) == bool(clock), "explicit original design clock")
    for cell in registers:
        require(cell["connections"]["CLK"] == module["ports"][clock]["bits"] and cell["parameters"]["CLK_POLARITY"].endswith("1" if edge == "posedge" else "0"), "every original register clock and edge")
    signals = {".".join(signal["path"][1:]): signal for signal in trace["signals"]}
    values = {name: [] for name in signals}
    for sample in trace["steps"]:
        for entry in sample["values"]:
            values[".".join(entry["path"][1:])].append(entry["bits"])
    properties = [{"id": name, "kind": cell["type"][1:], "source": cell["attributes"]["src"]}
                  for name, cell in module["cells"].items() if cell["type"] in {"$assert", "$assume", "$cover"}]
    locations = []
    for prop in properties:
        if prop["kind"] == "cover":
            continue
        match = re.fullmatch(r"([^:|\r\n]+):(\d+)\.\d+-\d+\.\d+", prop["source"])
        require(match is not None, "property location")
        locations.append({**prop, "path": match[1], "line": int(match[2])})
    ports = [{"name": name, "direction": port["direction"], "width": len(port["bits"]), "variable": "p" + str(index), "values": values[name]}
             for index, (name, port) in enumerate(module["ports"].items())]
    require(any(prop["kind"] == "assert" for prop in properties) and len({(prop["path"], prop["line"]) for prop in locations}) == len(locations), "distinct original property locations")
    for port in ports:
        require(port["direction"] in {"input", "output"} and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", port["name"]) is not None, "original port identity")
        require(signals[port["name"]]["width"] == port["width"] and module["ports"][port["name"]]["bits"] == module["netnames"][port["name"]]["bits"], "original port bit identity")
    inactive = 1 if edge == "negedge" else 0
    lines = ["`timescale 1ns/1ps", "module __formal_replay;"]
    for port in ports:
        lines.append(f"  {'reg' if port['direction'] == 'input' else 'wire'} [{port['width'] - 1}:0] {port['variable']};")
    lines.extend(["  \\top  dut (" + ", ".join(f".\\{port['name']} ({port['variable']})" for port in ports) + ");",
                  "  initial begin", '    $dumpfile("formal-replay.vcd");', "    $dumpvars(0, __formal_replay);"])
    clock_port = next((port for port in ports if port["name"] == clock), None)
    if clock_port:
        lines.append(f"    {clock_port['variable']} = 1'b{inactive};")
    observations = []
    for name, signal in signals.items():
        require(signal["path"][0] == "top" and all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_$]*", part) for part in signal["path"]), "original signal path")
        net = module["netnames"][name]
        require(len(net["bits"]) == signal["width"], "captured design width")
        for bit, digit in zip(net["bits"], reversed(values[name][0]), strict=True):
            require(bit not in initialized or initialized[bit] == digit, "captured initial value matches original design")
        if signal["clock"] is not None:
            require(clock_port and signal["width"] == 1 and net["bits"] == module["ports"][clock]["bits"] and signal["clock"] == edge, "captured clock alias")
        elif name not in module["ports"]:
            constant = all(bit in {"0", "1"} for bit in net["bits"])
            expression = f"{signal['width']}'b{''.join(reversed(net['bits']))}" if constant else "dut." + ".".join("\\" + part + " " for part in signal["path"][1:])
            observations.append((name, signal, expression, constant))
    for index in range(len(trace["steps"])):
        lines.append(f'    $display("FORMAL_REPLAY_DRIVE {index + 1}");')
        if index and clock_port:
            lines.append(f"    #1; {clock_port['variable']} = 1'b{1 - inactive};")
        for port in ports:
            if port["direction"] == "input" and port["name"] != clock:
                lines.append(f"    {port['variable']} {'<=' if index and clock_port else '='} {port['width']}'b{port['values'][index]};")
        if index and clock_port:
            lines.append(f"    #1; {clock_port['variable']} = 1'b{inactive};")
        lines.append("    #1;")
        checks = [(port["variable"], port["width"], port["values"][index], port["name"]) for port in ports if port["direction"] == "output"]
        checks += [(expression, signal["width"], values[name][index], name) for name, signal, expression, _ in observations]
        lines.extend(f'    if ({expression} !== {width}\'b{bits}) $fatal(1, "FORMAL_REPLAY_MISMATCH {index + 1} {name}");' for expression, width, bits, name in checks)
        lines.append(f'    $display("FORMAL_REPLAY_CHECK {index + 1}");')
    lines.extend(['    $display("FORMAL_REPLAY_DONE");', "    $finish;", "  end", "endmodule", ""])
    steps = len(trace["steps"])
    plan = {"path": "__formal/replay.v", "content": "\n".join(lines), "steps": steps, "locations": locations, "properties": properties,
            "ports": ports, "clock": clock, "edge": edge, "endTimeNs": 3 * steps - 2 if clock_port else steps,
            "origin": "smt", "phase": "basecase" if case == "prove-basecase" else "bmc", "modelSha256": capture["model"]["sha256"], "traceSha256": trace["sha256"]}
    return plan, signals, values, observations


def replay_result(evidence, prefix, plan, signals, values, observations):
    execution = evidence.data(prefix + "execution.json")
    require(type(execution["status"]) is int and execution["status"] == 0 and TRACE.positive(execution["elapsedMs"]), "normal replay execution")
    stdout, stderr, wave = (evidence.read(prefix + name) for name in ["stdout.log", "stderr.log", "replay.vcd"])
    require(not stderr.strip(), "replay stderr diagnostics")
    if prefix.endswith("replay-native/"):
        errors = []
        for stage in ["ivlpp", "ivl", "vvp"]:
            process = evidence.data(prefix + stage + ".json")
            require(type(process["status"]) is int and process["status"] == 0 and process["signal"] is None and process["error"] is None, "actual Icarus stage termination")
            errors.append(evidence.read(prefix + stage + ".stderr"))
        require(not evidence.read(prefix + "ivl.stdout") and evidence.read(prefix + "vvp.stdout") == stdout
                and b"\n".join(error for error in errors if error) == stderr, "complete native compile and run diagnostics")
    value, end, times, states, names = waveform(wave)
    require(end == plan["endTimeNs"], "complete replay waveform")
    inactive = "0" if plan["edge"] == "posedge" else "1"
    clock_names = [name for name, signal in signals.items() if signal["clock"] is not None]
    for name in clock_names:
        symbol = names.get(tuple(["__formal_replay", "dut", *name.split(".")]))
        require(symbol is not None, "missing waveform clock alias")
        previous = None
        transitions = []
        for time, state in zip(times, states, strict=True):
            actual = state.get(symbol)
            if actual != previous:
                transitions.append((time, actual)); previous = actual
        ticks = times[-1] / end
        expected = [(0, inactive)]
        for index in range(1, plan["steps"]):
            expected.extend([((3 * index - 1) * ticks, str(1 - int(inactive))), (3 * index * ticks, inactive)])
        require(transitions == expected, "replay clock edges and timing")
    for index in range(plan["steps"]):
        ns = 1 + 3 * index if plan["clock"] else index + 1
        for name, signal in signals.items():
            bits = values[name][index]
            if signal["clock"] is not None:
                bits = inactive
            constant = next((constant for observed, _, _, constant in observations if observed == name), False)
            if not constant:
                require(value(["__formal_replay", "dut", *name.split(".")], ns) == bits, "replay port or internal waveform sample")
    lines = stdout.decode("utf-8", errors="strict").splitlines()
    expected_markers = [marker for index in range(1, plan["steps"] + 1) for marker in [f"FORMAL_REPLAY_DRIVE {index}", f"FORMAL_REPLAY_CHECK {index}"]] + ["FORMAL_REPLAY_DONE"]
    require([line for line in lines if line.startswith("FORMAL_REPLAY_")] == expected_markers, "complete replay markers")
    step, failures, finished, position = 0, [], False, 0
    while position < len(lines):
        line = lines[position]; position += 1
        if line.startswith("FORMAL_REPLAY_DRIVE "):
            step = int(line.split()[-1])
        if line == "FORMAL_REPLAY_DONE":
            finished = True
        if not line.strip() or line.startswith("FORMAL_REPLAY_") or line == "VCD info: dumpfile formal-replay.vcd opened for output.":
            continue
        if finished and re.fullmatch(r"(?:work/)?__formal/replay\.v:\d+: \$finish called at \d+ \((?:1|10|100)(?:s|ms|us|ns|ps|fs)\)", line):
            continue
        match = re.fullmatch(r"ERROR: (?:work/)?([^:]+):(\d+):\s*", line)
        require(not finished and step and match is not None and position < len(lines), "unexpected replay diagnostic")
        detail = re.fullmatch(r"\s+Time: (\d+)\s+Scope: __formal_replay\.dut(?:\.[A-Za-z_][A-Za-z0-9_$]*)*\s*", lines[position])
        require(detail is not None, "replay diagnostic scope")
        begin = max(0, 3 * step - 5) if plan["clock"] else step - 1
        end = 3 * step - 2 if plan["clock"] else step
        require(begin * times[-1] / plan["endTimeNs"] <= int(detail[1]) <= end * times[-1] / plan["endTimeNs"], "property diagnosis belongs to the marked sample")
        position += 1
        prop = next((item for item in plan["locations"] if item["path"] == match[1] and item["line"] == int(match[2])), None)
        require(prop is not None and prop["kind"] == "assert", "assumption or unknown property diagnostic")
        failures.append({"id": prop["id"], "step": step, "source": prop["source"]})
    require(failures, "missing independent property violation")
    verification = {"status": "verified", "steps": plan["steps"], "failures": failures}
    require(TRACE.encoded(evidence.data(prefix + "verification.json")) == TRACE.encoded(verification), "verification derived from independent evidence")
    return {"runtime": prefix.rstrip("/").split("-")[-1], "expected": "verified", "actual": "verified", "exitCode": 0, "elapsedMs": execution["elapsedMs"],
            "steps": plan["steps"], "failures": compact(failures), "replaySha256": digest(plan["content"].encode()), "stdoutSha256": digest(stdout), "stderrSha256": digest(stderr), "vcdSha256": digest(wave), "error": None}


def audit(directory, formal=False):
    evidence = Evidence(directory)
    meta, result = evidence.data("metadata.json"), evidence.data("results.json")
    require(type(meta["format"]) is int and meta["format"] == 1 and type(meta["preliminary"]) is bool and result["preliminary"] is meta["preliminary"], "matching replay mode")
    formal = formal or not meta["preliminary"]
    require(not formal or meta["worktree"] == "" and meta["preliminary"] is False, "clean formal replay harness")
    require(meta["cases"] == CASES and TRACE.SOLVERS.select(meta["solvers"]), "complete fixture and solver inventory")
    require(re.fullmatch(r"[0-9a-f]{40}", meta["commit"]) is not None, "replay harness identity")
    for name, sha in meta["snapshots"].items():
        require(digest(evidence.read("snapshots/" + name)) == sha, "replay source snapshot")
    for name, sha in meta.get("baselineHashes", {}).items():
        require(digest(evidence.read("baseline/" + name)) == sha, "native baseline hash")
    baseline = evidence.data("baseline/metadata.json")
    require(TRACE.encoded(meta["baseline"]) == TRACE.encoded(baseline), "native baseline identity")
    require(not formal or baseline["worktree"] == "" and baseline["preliminary"] is False and baseline["commit"] == meta["commit"], "matching clean baseline")
    if formal:
        require(set(meta["baselineHashes"]) == {"metadata.json", "results.json"}, "complete native baseline hashes")
        for name, sha in baseline["sources"].items():
            require(meta["snapshots"][name] == sha, "matching native source snapshot")
        for name in ["node", "python", "pyodide", "submodules"]:
            require(type(meta[name]) is str and meta[name], "runtime version: " + name)
        require(meta["environment"] == {"LC_ALL": "C", "TZ": "UTC", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONHASHSEED": "0"}, "deterministic Python environment")
        require(all(type(meta["host"][key]) is int and meta["host"][key] > 0 for key in ["cpus", "memoryBytes"]), "host resources")
        version = evidence.data("versions/native-vvp.json")
        require(version["status"] == 0 and (version["stdout"] + version["stderr"]).strip() == meta["versions"]["iverilog"]
                and evidence.read("versions/wasi-vvp.log").decode().strip() == meta["versions"]["iverilog"], "actual native and WASI Icarus versions")
        for tool in ["yosys", "iverilog"]:
            for runtime in ["native", "wasi"]:
                name = tool + "-" + runtime
                build = evidence.data("build/" + name + ".json")
                require(TRACE.encoded(build) == TRACE.encoded(meta["builds"][name]) and build["mode"] == runtime, "compiled tool provenance")
                artifacts = build["artifacts"] if tool == "iverilog" else {build["artifact"]["path"]: build["artifact"]}
                for path, artifact in artifacts.items():
                    raw = evidence.read("inputs/" + name + "/" + path)
                    require(digest(raw) == artifact["sha256"] and len(raw) == artifact.get("bytes", artifact.get("size")), "compiled tool bytes")
            native, wasi = (meta["builds"][tool + "-" + runtime] for runtime in ["native", "wasi"])
            key = "iverilog" if tool == "iverilog" else "source"
            require(native[key] == wasi[key], "matching simulator or synthesis source pin")
        require(meta["builds"]["yosys-native"]["artifact"]["sha256"] == baseline["yosys"]["sha256"] and meta["versions"]["yosys"] == baseline["yosys"]["version"], "executed baseline Yosys identity")
    references = {(row["solver"], row["case"]): row for row in evidence.data("baseline/results.json")["rows"]}
    require(evidence.data("assets/manifest.json") == meta["assets"], "Python source manifest")
    for asset in meta["assets"]["assets"]:
        raw = evidence.read("assets/" + asset["path"])
        require(len(raw) == asset["size"] and digest(raw) == asset["sha256"], "Python source asset hash")
    reader = csv.DictReader(io.StringIO(evidence.read("results.csv").decode()), strict=True)
    csv_rows = list(reader)
    require(reader.fieldnames == COLUMNS and result["columns"] == COLUMNS and len(csv_rows) == len(result["rows"]), "complete replay columns")
    derived = []
    for solver in meta["solvers"]:
        probe = meta["probes"][solver]
        require(probe["native"]["source"] == probe["wasi"]["source"] and probe["command"]["sha256"] == probe["native"]["artifact"]["sha256"], "matching executed solver identity")
        TRACE.audit_resolved_native(probe)
        if formal:
            for runtime in ["native", "wasi"]:
                build = probe[runtime]
                version = evidence.data("versions/" + solver + "-" + runtime + ".json")
                release = re.search(r"\d+\.\d+\.\d+", build["source"]["version"])
                require(release is not None and version["status"] == 0 and (version["stdout"] + version["stderr"]).strip() == meta["versions"][solver][runtime]
                        and release[0] in meta["versions"][solver][runtime], "actual pinned solver versions")
                require(build["status"] == "built" and build["worktree_status"] == "" and build["source"]["commit"] == meta["sourcePins"][solver], "clean pinned solver build")
                binary = evidence.read("inputs/" + solver + ("-native" if runtime == "native" else ".wasm"))
                require(digest(binary) == build["artifact"]["sha256"] and len(binary) == build["artifact"]["bytes"], "executed solver bytes")
                require(digest(evidence.read("inputs/" + solver + "-" + runtime + "-build.py")) == build["script_sha256"], "executed solver build script")
                for patch in build["patches"]:
                    require(meta["snapshots"][patch["path"]] == patch["sha256"], "executed solver patch")
        for case in CASES:
            document = evidence.data(case + "-inventory/native.json")
            other = evidence.data(case + "-inventory/wasm.json")
            require({key: value for key, value in document.items() if key != "creator"} == {key: value for key, value in other.items() if key != "creator"}, "native and WASI design inventory")
            if case in {"arbitrary-initial", "unknown-initial", "memory"}:
                reason = {"arbitrary-initial": "fully initialized original registers", "unknown-initial": "concrete original initialization", "memory": "supported original state"}[case]
                try:
                    initialized_state(document["modules"]["top"])
                except ValueError as error:
                    require(str(error) == reason, "independently classified original unsupported state")
                else:
                    require(False, "expected unsupported original state")
            if case == "no-property":
                require(not any(cell["type"] == "$assert" for cell in document["modules"]["top"]["cells"].values()), "independent no-property boundary")
            reference = references[solver, case]
            base = {"solver": solver, "case": case, "phase": "basecase" if case == "prove-basecase" else "bmc", "designSha256": digest(compact(document).encode())}
            if case == "combinational-loop":
                raw = evidence.read(solver + "-" + case + "/top.v")
                upstream = evidence.data(solver + "-" + case + "/upstream.json")
                require(digest(raw) == reference["files"]["top.v"]["sha256"], "original loop source identity")
                require(upstream == reference and reference["kind"] == "tool-error" and reference["exitCode"] != 0, "upstream combinational loop rejection")
                derived.append({**base, "sourceSha256": digest(raw), "origin": "native", "runtime": "none", "expected": "tool-error", "actual": "tool-error", "exitCode": reference["exitCode"], "elapsedMs": reference["elapsedMs"]})
                continue
            first, captures, within = None, [], {}
            no_trace = case in {"depth-n-minus-1", "no-property", "vacuous-assumption"}
            code = 0 if case in {"depth-n-minus-1", "no-property"} else 1
            for origin in ["native", "pyodide"]:
                for entrypoint in ["smtbmc", "formal_trace"]:
                    prefix = f"{solver}-{case}/{origin}-{entrypoint}/"
                    process = evidence.data(prefix + "process.json")
                    require(process["status"] == "exited" and type(process["exitCode"]) is int and process["exitCode"] == code and TRACE.positive(process["elapsedMs"]), "normal original SMTBMC termination")
                    args = ["-s", "yices" if solver == "yices2" else solver, "--presat", "--noprogress"] + (["--unroll"] if solver == "yices2" else [])
                    args += ["-t", str(DEPTHS.get(case, 6)), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"]
                    require(process["args"] == args and process.get("error") is None, "original SMTBMC argument and depth identity")
                    if origin == "pyodide":
                        require(process["integrityVerified"] is True, "verified original Python assets")
                        TRACE.SOLVERS.audit_children(process["children"], solver, probe["wasi"]["artifact"]["sha256"], "bmc-safe" if no_trace else "bmc-violation", "bmc")
                    files = prefix + "files/"
                    names = ["top.v", "model.smt2"] + ([] if no_trace else ["trace.vcd", "trace.yw", "trace_tb.v"])
                    artifacts = {name: evidence.read(files + name) for name in names}
                    require(evidence.files(files.rstrip("/")) == set(names) | ({"formal-trace.json"} if entrypoint == "formal_trace" else set()), "complete original artifact inventory")
                    source, model = artifacts["top.v"], artifacts["model.smt2"]
                    require(digest(source) == reference["files"]["top.v"]["sha256"] and digest(model) == reference["files"]["result/model/design_smt2.smt2"]["sha256"], "original source and prepared model identity")
                    stdout, stderr = evidence.read(prefix + "stdout.log"), evidence.read(prefix + "stderr.log")
                    expected_status = "PREUNSAT" if case == "vacuous-assumption" else "PASSED" if code == 0 else "FAILED"
                    require(not stderr and re.findall(rb"Status: (\w+)", stdout) == [expected_status.encode()], "original SMTBMC status and diagnostics")
                    comparison = (re.sub(rb"^##\s+\d+:\d\d:\d\d\s+", b"## TIME ", stdout, flags=re.M), stderr, artifacts)
                    require(origin not in within or comparison == within[origin], "recording preserves all raw original artifacts")
                    within[origin] = comparison
                    normalized = dict(artifacts)
                    if not no_trace:
                        normalized["trace_tb.v"] = normalize_tb(artifacts["trace_tb.v"].decode()).encode()
                    cross = (comparison[0], stderr, normalized)
                    require(first is None or cross == first, "cross-runtime original artifact identity except PI ordering")
                    first = cross
                    if entrypoint != "formal_trace":
                        continue
                    sha, _ = TRACE.capture(evidence, files, code, digest(model), not no_trace)
                    capture = evidence.data(files + "formal-trace.json")
                    captures.append(evidence.read(files + "formal-trace.json"))
                    fields = {**base, "origin": origin, "sourceSha256": digest(source), "modelSha256": digest(model), "captureSha256": sha, "sourceVcdSha256": digest(b"" if no_trace else artifacts["trace.vcd"])}
                    if case in REJECTED:
                        require(evidence.data(prefix + "rejection.json") == {"reason": REJECTED[case]}, "unsupported replay rejection reason")
                        derived.append({**fields, "runtime": "none", "expected": "rejected", "actual": "rejected", "exitCode": code, "elapsedMs": process["elapsedMs"], "error": REJECTED[case]})
                        continue
                    plan, signals, values, observations = expected_plan(document, capture, case)
                    require(TRACE.encoded(evidence.data(prefix + "plan.json")) == TRACE.encoded(plan) and evidence.read(prefix + "replay.v") == plan["content"].encode(), "complete independently derived read-only replay testbench")
                    for runtime in ["native", "wasm"]:
                        derived.append({**fields, **replay_result(evidence, prefix + "replay-" + runtime + "/", plan, signals, values, observations)})
            require(captures[0] == captures[1], "native and Pyodide capture bytes")
    expected_rows = [{name: row.get(name) for name in COLUMNS} for row in derived]
    require(len(expected_rows) == 53 * len(meta["solvers"]), "complete replay row inventory")
    require(TRACE.encoded(result["rows"]) == TRACE.encoded(expected_rows), "all JSON replay columns independently derived")
    for row, csv_row in zip(expected_rows, csv_rows, strict=True):
        require(csv_row == {key: "" if value is None else str(value) for key, value in row.items()}, "all CSV replay columns independently derived")
    return {"status": "pass", "rows": len(expected_rows), "columns": len(COLUMNS), "preliminary": not formal}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--formal", action="store_true")
    args = parser.parse_args()
    print(json.dumps(audit(args.directory, args.formal), sort_keys=True))
