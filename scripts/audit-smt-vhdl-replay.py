#!/usr/bin/env python3
"""SMTの記録を元VHDL/PSL(GHDL)と下位化Verilog(Icarus)で再実行した証拠の全列を独立に照合する。"""

import argparse
import csv
from fractions import Fraction
import importlib.util
import io
import json
from pathlib import Path
import re


SPEC = importlib.util.spec_from_file_location("smt_vhdl_verilog_audit", Path(__file__).with_name("audit-smt-replay.py"))
VERILOG = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERILOG)
TRACE = VERILOG.TRACE
require, digest, Evidence, compact, encoded = TRACE.require, TRACE.digest, TRACE.Evidence, VERILOG.compact, TRACE.encoded
COLUMNS = ("solver case origin runtime target phase expected actual exitCode elapsedMs steps failures sourceSha256 vhdlSha256 loweredSha256 "
           "modelSha256 captureSha256 sourceVcdSha256 designSha256 replaySha256 stdoutSha256 stderrSha256 vcdSha256 pslReportSha256 error").split()


def fixture(depth, status="FAIL", replay="verified", vhdl=None, mode="bmc", edge="posedge", psl=False):
    return {"depth": depth, "status": status, "replay": replay, "vhdl": vhdl or replay, "mode": mode, "edge": edge, "psl": psl}


FIXTURES = {
    "depth-n-minus-1": fixture(3, "PASS", "rejected"),
    "depth-n": fixture(4),
    "depth-n-plus-1": fixture(5),
    "prove-basecase": fixture(5, mode="prove"),
    "negedge": fixture(5, edge="negedge"),
    "nonzero-initial": fixture(5),
    "psl": fixture(5, psl=True),
    "combinational": fixture(3),
    "reset": fixture(5),
    "assumption": fixture(5, psl=True),
    "multiple-properties": fixture(5),
    "hierarchy": fixture(5),
    "arbitrary-initial": fixture(5, replay="rejected"),
    "memory": fixture(5, vhdl="rejected"),
    "no-property": fixture(3, "PASS", "rejected"),
    "vacuous-assumption": fixture(3, "ERROR", "rejected", psl=True),
}
CASES = list(FIXTURES)
REJECTED = {
    "depth-n-minus-1": "SMT replay requires one complete failing assertion trace",
    "arbitrary-initial": "Replay of unconstrained initial state is unsupported",
    "no-property": "No assertion targets in formal design",
}
SCRIPTS = {
    "inventory": "read_verilog -formal -icells top.v; hierarchy -check -top top; proc; flatten; async2sync; chformal -lower; write_json __formal/before.json",
    "emit": "read_verilog -formal -icells top.v; hierarchy -top top; proc; flatten; async2sync; chformal -cover -remove; write_verilog __formal/replay-design.v",
    "inspect": "read_verilog -formal top.v; hierarchy -check -top top; proc; flatten; async2sync; chformal -lower; write_json __formal/before.json",
}
GHDL_STDERR = "loading VPI module './replay.vpi'\nVPI module loaded!\n"
BASELINE_ERROR = "Upstream SBY ERROR exit 16"
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def js_failures(failures, order):
    return json.dumps([{key: item[key] for key in order} for item in failures], ensure_ascii=False, separators=(",", ":"))


def without_creator(document):
    return {key: value for key, value in document.items() if key != "creator"}


def state_signals(module):
    owners = {}
    for name, net in module["netnames"].items():
        for bit in net["bits"]:
            owners.setdefault(bit, []).append(name)
    names = set()
    for cell in module["cells"].values():
        if cell["type"] == "$dff":
            for bit in cell["connections"]["Q"]:
                names.update(name for name in owners.get(bit, []) if IDENTIFIER.fullmatch(name) and name not in module["ports"])
    return names


def properties(module):
    found = []
    for name, cell in module["cells"].items():
        require(cell["type"] not in {"$check", "$live", "$fair"}, "unlowered formal cell")
        if cell["type"] in {"$assert", "$assume", "$cover"}:
            source = cell["attributes"]["src"]
            require(type(source) is str and source.strip(), "formal property source")
            found.append({"id": name, "kind": cell["type"][1:], "source": source})
    return found


def registers(module):
    return [cell for cell in module["cells"].values() if cell["type"] == "$dff"]


def expected_plan(document, capture, case):
    spec = FIXTURES[case]
    module = document["modules"]["top"]
    trace = capture["traces"][0]
    clock, edge = "clk", spec["edge"]
    initialized = VERILOG.initialized_state(module)
    require(0 < len(trace["steps"]) <= spec["depth"], "original trace depth boundary")
    cells = registers(module)
    require(cells, "explicit lowered design clock")
    for cell in cells:
        require(cell["connections"]["CLK"] == module["ports"][clock]["bits"] and cell["parameters"]["CLK_POLARITY"].endswith("1" if edge == "posedge" else "0"), "every lowered register clock and edge")
    signals = {".".join(signal["path"][1:]): signal for signal in trace["signals"]}
    values = {name: [] for name in signals}
    for sample in trace["steps"]:
        for entry in sample["values"]:
            values[".".join(entry["path"][1:])].append(entry["bits"])
    props = properties(module)
    require(any(prop["kind"] == "assert" for prop in props), "lowered assertion target")
    locations = []
    for prop in props:
        if prop["kind"] == "cover":
            continue
        match = re.fullmatch(r"([^:|\r\n]+):(\d+)\.\d+-\d+\.\d+", prop["source"])
        require(match is not None, "property location")
        locations.append({**prop, "path": match[1], "line": int(match[2])})
    require(len({(prop["path"], prop["line"]) for prop in locations}) == len(locations), "distinct original property locations")
    ports = []
    for index, (name, port) in enumerate(module["ports"].items()):
        require(port["direction"] in {"input", "output"} and IDENTIFIER.fullmatch(name) and name in signals, "original port identity")
        require(signals[name]["width"] == len(port["bits"]) and port["bits"] == module["netnames"][name]["bits"], "original port bit identity")
        ports.append({"name": name, "direction": port["direction"], "width": len(port["bits"]), "variable": "p" + str(index), "values": values[name]})
    clock_bits = module["ports"][clock]["bits"]
    observe, observations = state_signals(module), []
    for name, signal in signals.items():
        require(signal["path"][0] == "top" and all(IDENTIFIER.fullmatch(part) for part in signal["path"]), "original signal path")
        net = module["netnames"][name]
        require(len(net["bits"]) == signal["width"], "captured design width")
        for bit, digit in zip(net["bits"], reversed(values[name][0]), strict=True):
            require(bit not in initialized or initialized[bit] == digit, "captured initial value matches lowered design")
        alias = signal["width"] == 1 and net["bits"] == clock_bits
        require(signal["clock"] == (edge if alias else None) and not (alias and name != clock and name in module["ports"]), "captured clock alias")
        if signal["clock"] is None and name not in module["ports"] and name in observe:
            constant = all(bit in {"0", "1"} for bit in net["bits"])
            expression = f"{signal['width']}'b{''.join(reversed(net['bits']))}" if constant else "dut." + ".".join("\\" + part + " " for part in signal["path"][1:])
            observations.append((name, signal, expression))
    require(observe <= {name for name, _, _ in observations}, "every lowered state output observed")
    inactive = 1 if edge == "negedge" else 0
    lines = ["`timescale 1ns/1ps", "module __formal_replay;"]
    lines += [f"  {'reg' if port['direction'] == 'input' else 'wire'} [{port['width'] - 1}:0] {port['variable']};" for port in ports]
    lines += ["  \\top  dut (" + ", ".join(f".\\{port['name']} ({port['variable']})" for port in ports) + ");",
              "  initial begin", '    $dumpfile("formal-replay.vcd");', "    $dumpvars(0, __formal_replay);"]
    clock_port = next(port for port in ports if port["name"] == clock)
    lines.append(f"    {clock_port['variable']} = 1'b{inactive};")
    for index in range(len(trace["steps"])):
        lines.append(f'    $display("FORMAL_REPLAY_DRIVE {index + 1}");')
        if index:
            lines.append(f"    #1; {clock_port['variable']} = 1'b{1 - inactive};")
        for port in ports:
            if port["direction"] == "input" and port["name"] != clock:
                lines.append(f"    {port['variable']} {'<=' if index else '='} {port['width']}'b{port['values'][index]};")
        if index:
            lines.append(f"    #1; {clock_port['variable']} = 1'b{inactive};")
        lines.append("    #1;")
        checks = [(port["variable"], port["width"], port["values"][index], port["name"]) for port in ports if port["direction"] == "output"]
        checks += [(expression, signal["width"], values[name][index], name) for name, signal, expression in observations]
        lines += [f'    if ({expression} !== {width}\'b{bits}) $fatal(1, "FORMAL_REPLAY_MISMATCH {index + 1} {name}");' for expression, width, bits, name in checks]
        lines.append(f'    $display("FORMAL_REPLAY_CHECK {index + 1}");')
    lines += ['    $display("FORMAL_REPLAY_DONE");', "    $finish;", "  end", "endmodule", ""]
    steps = len(trace["steps"])
    plan = {"path": "__formal/replay.v", "content": "\n".join(lines), "steps": steps, "locations": locations, "properties": props,
            "ports": ports, "clock": clock, "edge": edge, "endTimeNs": 3 * steps - 2, "origin": "smt",
            "phase": "basecase" if spec["mode"] == "prove" else "bmc", "modelSha256": capture["model"]["sha256"], "traceSha256": trace["sha256"]}
    return plan, signals, values, observations


def aliases(module, bit):
    if type(bit) is str:
        return {"constant:" + bit}
    return {f"wire:{name}:{index}" for name, net in module["netnames"].items() for index, candidate in enumerate(net["bits"]) if candidate == bit}


def bind_lowered(plan, original, emitted):
    require(all(name == "top" or name.startswith("$") for document in [original, emitted] for name in document["modules"]), "flattened lowered replay design")
    first, second = original["modules"]["top"], emitted["modules"]["top"]
    left, right = properties(first), properties(second)
    for kind in ["assert", "assume"]:
        require(sum(p["kind"] == kind for p in left) == sum(p["kind"] == kind for p in right), "lowered property inventory")
    require(not any(p["kind"] == "cover" for p in right), "Icarus replay model without covers")
    require(len(registers(first)) == len(registers(second)), "lowered state inventory")

    def initial(module, bit):
        found = set()
        for net in module["netnames"].values():
            if bit in net["bits"] and "init" in net.get("attributes", {}):
                found.add(net["attributes"]["init"][::-1][net["bits"].index(bit)])
        return sorted(found)

    used = set()
    for cell in registers(first):
        matches = [name for name, other in second["cells"].items() if other["type"] == "$dff" and len(other["connections"]["Q"]) == len(cell["connections"]["Q"])
                   and all(aliases(first, a) & aliases(second, b) and initial(first, a) == initial(second, b) for a, b in zip(cell["connections"]["Q"], other["connections"]["Q"]))]
        require(len(matches) == 1 and matches[0] not in used, "lowered state identity, width and initial value")
        used.add(matches[0])
    signature = lambda module: sorted((name, port["direction"], len(port["bits"])) for name, port in module["ports"].items())
    require(signature(first) == signature(second), "lowered port inventory")
    mappings, used = [], set()
    for prop in [p for p in left if p["kind"] != "cover"]:
        cell = first["cells"][prop["id"]]
        matches = [other for other in right if other["kind"] == prop["kind"] and all(
            aliases(first, cell["connections"][port][0]) & aliases(second, second["cells"][other["id"]]["connections"][port][0]) for port in ["A", "EN"])]
        require(len(matches) == 1 and matches[0]["id"] not in used, "unique lowered property mapping")
        used.add(matches[0]["id"])
        match = re.fullmatch(r"([^:|\r\n]+):(\d+)\.\d+-\d+\.\d+", matches[0]["source"])
        require(match is not None, "lowered property source location")
        mappings.append({**prop, "emittedId": matches[0]["id"], "emittedSource": matches[0]["source"], "path": match[1], "line": int(match[2])})
    require(len(mappings) == len(plan["locations"]) and len({(m["path"], m["line"]) for m in mappings}) == len(mappings), "complete lowered source locations")
    bound = {key: value for key, value in plan.items() if key != "content"}
    bound.update(locations=mappings, mappings=mappings, omittedCovers=[p for p in left if p["kind"] == "cover"], contentSha256=digest(plan["content"].encode()))
    return bound


def lowered_result(evidence, prefix, plan, bound, signals, values, observations, emitted_source):
    execution = evidence.data(prefix + "execution.json")
    require(set(execution) == {"status", "elapsedMs"} and type(execution["status"]) is int and execution["status"] == 0 and TRACE.positive(execution["elapsedMs"]), "normal lowered replay execution")
    stdout, stderr, wave = (evidence.read(prefix + name) for name in ["stdout.log", "stderr.log", "replay.vcd"])
    require(not stderr.strip(), "lowered replay stderr diagnostics")
    if prefix.endswith("lowered-native/"):
        errors = []
        for stage in ["ivlpp", "ivl", "vvp"]:
            process = evidence.data(prefix + stage + ".json")
            require(type(process["status"]) is int and process["status"] == 0 and process["signal"] is None and process["error"] is None, "actual Icarus stage termination")
            errors.append(evidence.read(prefix + stage + ".stderr"))
        require(not evidence.read(prefix + "ivl.stdout") and evidence.read(prefix + "vvp.stdout") == stdout
                and b"\n".join(error for error in errors if error) == stderr, "complete native compile and run diagnostics")
        require(evidence.read(prefix + "work/top.v") == emitted_source and evidence.read(prefix + "work/__formal/replay.v") == plan["content"].encode(), "executed lowered design and replay bytes")
    value, end, times, states, names = VERILOG.waveform(wave)
    require(end == plan["endTimeNs"], "complete lowered replay waveform")
    inactive = "0" if plan["edge"] == "posedge" else "1"
    symbol = names.get(("__formal_replay", "dut", plan["clock"]))
    require(symbol is not None, "missing waveform clock")
    transitions, previous = [], None
    for time, state in zip(times, states, strict=True):
        if state.get(symbol) != previous:
            transitions.append((time, state.get(symbol))); previous = state.get(symbol)
    ticks = times[-1] / end
    expected = [(0, inactive)]
    for index in range(1, plan["steps"]):
        expected += [((3 * index - 1) * ticks, str(1 - int(inactive))), (3 * index * ticks, inactive)]
    require(transitions == expected, "lowered replay clock edges and timing")
    observed = {port["name"] for port in plan["ports"] if port["name"] != plan["clock"]} | {name for name, _, expression in observations if expression.startswith("dut.")}
    for index in range(plan["steps"]):
        for name in observed:
            require(value(["__formal_replay", "dut", *name.split(".")], 1 + 3 * index) == values[name][index], "lowered port or state waveform sample")
    lines = stdout.decode("utf-8", errors="strict").splitlines()
    markers = [marker for index in range(1, plan["steps"] + 1) for marker in [f"FORMAL_REPLAY_DRIVE {index}", f"FORMAL_REPLAY_CHECK {index}"]] + ["FORMAL_REPLAY_DONE"]
    require([line for line in lines if line.startswith("FORMAL_REPLAY_")] == markers, "complete lowered replay markers")
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
        require(not finished and step and match is not None and position < len(lines), "unexpected lowered replay diagnostic")
        detail = re.fullmatch(r"\s+Time: (\d+)\s+Scope: __formal_replay\.dut(?:\.[A-Za-z_][A-Za-z0-9_$]*)*\s*", lines[position])
        require(detail is not None, "lowered replay diagnostic scope")
        require(max(0, 3 * step - 5) * ticks <= int(detail[1]) <= (3 * step - 2) * ticks, "property diagnosis belongs to the marked sample")
        position += 1
        prop = next((item for item in bound["locations"] if item["path"] == match[1] and item["line"] == int(match[2])), None)
        require(prop is not None and prop["kind"] == "assert", "assumption or unknown lowered property diagnostic")
        failures.append({"id": prop["id"], "step": step, "source": prop["source"]})
    require(failures, "missing lowered property violation")
    require(encoded(evidence.data(prefix + "verification.json")) == encoded({"status": "verified", "steps": plan["steps"], "failures": failures}), "lowered verification derived from independent evidence")
    return {"runtime": prefix.rstrip("/").split("-")[-1], "target": "lowered", "expected": "verified", "actual": "verified", "exitCode": 0,
            "elapsedMs": execution["elapsedMs"], "steps": plan["steps"], "failures": js_failures(failures, ["id", "step", "source"]),
            "replaySha256": digest(plan["content"].encode()), "stdoutSha256": digest(stdout), "stderrSha256": digest(stderr), "vcdSha256": digest(wave), "error": None}


def ghdl_plan(plan, psl):
    ports = [port for port in plan["ports"] if port["name"] != plan["clock"]]
    require(ports and all(re.fullmatch(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*", port["name"]) for port in ports), "GHDL replay ports")
    inactive = 0 if plan["edge"] == "posedge" else 1
    lines = [f"FORMAL_GHDL_V1 {plan['steps']} {len(ports)} {int(psl)} {inactive} top.{plan['clock']}"]
    markers, times = [], []
    for step in range(plan["steps"]):
        if step:
            markers.append(f"FORMAL_GHDL_EDGE {step + 1}"); times.append(10 * step)
        lines.append(f"STEP {step + 1}")
        markers.append(f"FORMAL_GHDL_DRIVE {step + 1}"); times.append(10 * step + (1 if step else 0))
        for port in ports:
            text = f"{'I' if port['direction'] == 'input' else 'O'} top.{port['name']} {port['values'][step]}"
            lines.append(text)
            markers.append(f"FORMAL_GHDL_PORT {step + 1} {text}"); times.append(10 * step + 2)
        markers.append(f"FORMAL_GHDL_CHECK {step + 1}"); times.append(10 * step + 2)
    if psl:
        markers.append("FORMAL_GHDL_FLUSH"); times.append(10 * plan["steps"])
    end = 10 * plan["steps"] + 1 if psl else 10 * (plan["steps"] - 1) + 3
    markers.append("FORMAL_GHDL_DONE"); times.append(end)
    content = "\n".join(lines) + "\n"
    result = {key: value for key, value in plan.items() if key != "content"}
    result.update(top="top", psl=psl, ports=ports, inactive=inactive, markers=markers, markerTimesNs=times, endTimeNs=end, contentSha256=digest(content.encode()))
    return result, content


def property_at(plan, file, line, kind):
    found = [p for p in plan["properties"] if p["kind"] == kind and re.match(rf"{line}\.", p["source"].rsplit(":", 1)[1]) and p["source"].rsplit(":", 1)[0] == file]
    require(len(found) == 1, "Unknown or ambiguous original VHDL property")
    return found[0]


def psl_report(plan, raw, diagnostics):
    report = TRACE.SBY.strict_json(raw)
    require(type(report) is dict and type(report.get("details")) is list and type(report.get("summary")) is dict, "Missing PSL report")
    totals = {f"{kind}{suffix}": 0 for kind in ["assert", "assume", "cover"] for suffix in ["", "-failure", "-pass"]}
    seen = set()
    for detail in report["details"]:
        kind = {"assertion": "assert", "assumption": "assume", "cover": "cover"}.get(detail.get("directive"))
        require(plan["psl"] and kind and type(detail.get("name")) is str and detail["name"] not in seen, "Unexpected or duplicate PSL directive")
        seen.add(detail["name"])
        counters = [detail.get("finished-count"), detail.get("started-count")]
        require(type(detail.get("line")) is int and detail["line"] > 0 and all(type(value) is int and value >= 0 for value in counters), "Invalid PSL counters")
        prop = property_at(plan, detail["file"], detail["line"], kind)
        require(detail["name"].startswith(".top(") and detail["name"].endswith("." + prop["id"]), "PSL report property label mismatch")
        finished = detail["finished-count"]
        require(detail["status"] == (("covered" if finished else "not covered") if kind == "cover" else ("failed" if finished else "passed")), "PSL status and counter disagree")
        count = sum(event["psl"] and event["id"] == prop["id"] for event in diagnostics)
        require(count == (0 if kind == "cover" else finished), "PSL report and diagnostic count disagree")
        totals[kind] += 1
        totals[f"{kind}-{('pass' if finished else 'failure') if kind == 'cover' else ('failure' if finished else 'pass')}"] += 1
        require(kind != "assume" or finished == 0, "Original VHDL violated an assumption")
    require(report["summary"] == totals, "PSL summary and details disagree")
    for prop in [p for p in plan["properties"] if p["kind"] != "assert"]:
        if prop["kind"] == "cover" and any(o["kind"] == "assert" and o["id"] + "_cover" == prop["id"] and o["source"] == prop["source"] for o in plan["properties"]):
            continue
        require(any(d["name"].endswith("." + prop["id"]) and property_at(plan, d["file"], d["line"], prop["kind"])["id"] == prop["id"] for d in report["details"]), "PSL report omitted an assumption or explicit cover")
    for event in [e for e in diagnostics if e["psl"]]:
        require(any(d["file"] == event["path"] and d["line"] == event["line"] for d in report["details"]), "PSL report omitted a diagnostic")
    return report


def ghdl_vcd(plan, raw):
    text = raw.decode("utf-8", errors="strict")
    end = re.search(r"\$enddefinitions\s+\$end\s*", text)
    require(end is not None, "Missing VCD header")
    header, ticks, scopes, declarations, targets, roots, consumed = text[:end.start()], None, [], {}, {}, 0, 0
    for item in re.finditer(r"\$(\w+)\b([\s\S]*?)\$end\s*", header):
        require(not header[consumed:item.start()].strip(), "Unknown VCD header text")
        consumed = item.end()
        directive, body = item[1], item[2]
        parts = body.split()
        if directive == "scope":
            require(len(parts) == 2 and parts[0] == "module", "Invalid VCD scope")
            roots += not scopes and parts[1] == "top"
            scopes.append(parts[1])
        elif directive == "upscope":
            require(scopes and not body.strip(), "Invalid VCD scope end")
            scopes.pop()
        elif directive == "var":
            require(len(parts) >= 4 and parts[0] in {"reg", "wire", "integer"} and parts[1].isdigit(), "Invalid VCD variable")
            width, ident = int(parts[1]), parts[2]
            require(0 < width <= 4096 and ident not in declarations, "Invalid or ambiguous VCD variable")
            declarations[ident] = width
            if scopes == ["top"]:
                name = re.sub(r"\[\d+:\d+\]$", "", parts[3])
                if name in {port["name"] for port in plan["ports"]} | {plan["clock"]}:
                    require(name not in targets, "Duplicate replay VCD port")
                    targets[name] = (ident, width)
        elif directive == "timescale":
            scale = re.fullmatch(r"(1|10|100)\s*(fs|ps|ns|us|ms|s)", body.strip())
            require(ticks is None and scale is not None, "Invalid VCD time scale")
            ticks = Fraction(10) ** {"fs": 6, "ps": 3, "ns": 0, "us": -3, "ms": -6, "s": -9}[scale[2]] / int(scale[1])
        else:
            require(directive in {"date", "version", "comment"}, "Unknown VCD directive")
    require(not header[consumed:].strip() and ticks is not None and ticks.denominator == 1 and ticks > 0, "Missing or unsupported VCD time precision")
    require(not scopes and roots == 1, "Missing or ambiguous replay VCD scope")
    for port in plan["ports"]:
        require(targets.get(port["name"], (None, None))[1] == port["width"], "Missing or mismatched VCD port")
    require(targets.get(plan["clock"], (None, None))[1] == 1, "Missing VCD clock")
    values, clock_events, time, sample = {}, [], -1, 0

    def check(limit):
        nonlocal sample
        while sample < plan["steps"] and (10 * sample + 2) * ticks < limit:
            for port in plan["ports"]:
                require(values.get(targets[port["name"]][0]) == port["values"][sample], "VCD witness mismatch")
            sample += 1

    for line in text[end.end():].strip().splitlines():
        match = re.fullmatch(r"#(\d+)", line)
        if match:
            following = int(match[1])
            require(following > time and following <= plan["endTimeNs"] * ticks and (time != -1 or following == 0), "Invalid VCD timestamp")
            check(following)
            time = following
            continue
        match = re.fullmatch(r"b([01xXzZ]+)\s+(\S+)", line) or re.fullmatch(r"([01xXzZ])(\S+)", line)
        require(time >= 0 and match is not None and match[2] in declarations and len(match[1]) <= declarations[match[2]], "Unknown VCD value")
        bits = match[1].lower()
        values[match[2]] = bits.rjust(declarations[match[2]], bits[0] if bits[0] in "xz" else "0")
        if targets[plan["clock"]][0] == match[2]:
            clock_events.append((time, values[match[2]]))
    require(time == plan["endTimeNs"] * ticks, "Incomplete VCD end timestamp")
    check(time + 1)
    require(sample == plan["steps"], "Incomplete VCD observations")
    expected = [(0, str(plan["inactive"]))]
    for ns in range(1, plan["endTimeNs"] + 1):
        if ns % 10 == 0:
            expected.append((ns * ticks, str(1 - plan["inactive"])))
        if ns % 10 == 5 and ns >= 15:
            expected.append((ns * ticks, str(plan["inactive"])))
    require(clock_events == expected, "VCD clock does not match the replay schedule")
    return ticks


def verify_ghdl(plan, stdout, stderr, report, vcd):
    try:
        require(stderr == GHDL_STDERR, "Unexpected GHDL stderr diagnostic")
        lines = stdout.rstrip().split("\n")
        begin = re.fullmatch(r"FORMAL_GHDL_BEGIN (\d+) (\d+) (-\d+)", lines.pop(0))
        require(begin and int(begin[1]) == plan["steps"] and int(begin[2]) == len(plan["ports"]) and -15 <= int(begin[3]) <= -9, "Missing GHDL startup marker")
        observed, diagnostics, failures, trailing = [], [], [], []
        files = {p["source"].rsplit(":", 1)[0] for p in plan["properties"]}
        index = 0
        while index < len(lines):
            line = lines[index]
            if line.startswith("FORMAL_GHDL_"):
                observed.append(line); index += 1; continue
            match = re.fullmatch(r"([^:]+):(\d+):(\d+):@(\d+)(fs|ps|ns|us|ms|sec):\((assertion|psl assertion|psl assumption|psl cover) (note|warning|error|failure)\): (.*)", line)
            require(match is not None, "Unknown original VHDL diagnostic")
            file, number, column, digits, unit, kind_text = match[1], int(match[2]), match[3], int(match[4]), match[5], match[6]
            kind = "cover" if kind_text == "psl cover" else "assume" if kind_text == "psl assumption" else "assert"
            if file not in files:
                while index + 1 < len(lines) and lines[index + 1].startswith(("  instance:", "  from:")):
                    index += 1
                index += 1
                continue
            prop = property_at(plan, file, number, kind)
            require(prop["source"].startswith(f"{file}:{number}.{column}-"), "Original VHDL diagnostic column mismatch")
            index += 1
            instance = re.fullmatch(r"  instance: (/top(?:/[a-z0-9_/]+)?)", lines[index] if index < len(lines) else "")
            require(instance and (instance[1] == "/top" or instance[1].endswith("/" + prop["id"].replace(".", "/"))), "Missing or mismatched VHDL diagnostic instance")
            if index + 1 < len(lines) and lines[index + 1].startswith("  from: process "):
                index += 1
                origin = lines[index]
                annotation = re.search(r" at ([^:\r\n]+):(\d+)$", origin)
                if annotation:
                    require(annotation[1] == file and int(annotation[2]) == number, "Original VHDL process source mismatch")
                require((origin[:annotation.start()] if annotation else origin).endswith("." + prop["id"].split(".")[-1]), "Original VHDL diagnostic label mismatch")
            ns = Fraction(digits) * Fraction(10) ** {"fs": -6, "ps": -3, "ns": 0, "us": 3, "ms": 6, "sec": 9}[unit]
            require(ns.denominator == 1, "Unaligned or invalid diagnostic time")
            ns, psl = int(ns), kind_text.startswith("psl ")
            require(0 < len(observed) < len(plan["markers"]) and plan["markerTimesNs"][len(observed) - 1] <= ns <= plan["markerTimesNs"][len(observed)], "Diagnostic is outside its replay marker phase")
            require(ns <= plan["endTimeNs"] and (not psl or plan["psl"] and ns > 0 and ns % 10 == 0), "Unexpected original VHDL diagnostic phase")
            if psl:
                require(re.fullmatch(r"FORMAL_GHDL_(EDGE \d+|FLUSH)", observed[-1]), "PSL diagnostic did not follow its sampling edge")
            step = ns // 10 if psl else ns // 10 + 1
            event = {"id": prop["id"], "kind": kind, "path": file, "line": number, "source": prop["source"], "ns": ns, "step": step, "psl": psl}
            diagnostics.append(event)
            require(kind != "assume", "Original VHDL violated an assumption")
            if step > plan["steps"]:
                require(plan["psl"] and not psl and ns == 10 * plan["steps"], "Unexpected post-witness diagnostic")
                trailing.append(event)
            elif kind == "assert":
                if not psl and step > 1 and ns % 10 < 1:
                    require(all(p["direction"] != "input" or p["values"][step - 1] == p["values"][step - 2] for p in plan["ports"]), "Ambiguous assertion during an input transition")
                failures.append({"id": prop["id"], "source": prop["source"], "step": step})
            index += 1
        require(observed == plan["markers"], "Incomplete or inconsistent GHDL replay markers")
        require(failures, "Original VHDL did not reproduce an assertion failure within the witness")
        parsed = psl_report(plan, report, diagnostics)
        require(ghdl_vcd(plan, vcd) == 10 ** (-9 - int(begin[3])), "VCD and VPI time precision disagree")
        return {"status": "verified", "steps": plan["steps"], "failures": failures, "trailing": trailing, "diagnostics": diagnostics, "pslReport": parsed}
    except ValueError as error:
        return {"status": "rejected", "reason": str(error)}


def ghdl_result(evidence, prefix, plan, psl, source, plugin, expected):
    gplan, content = ghdl_plan(plan, psl)
    require(encoded(evidence.data(prefix + "ghdl-plan.json")) == encoded(gplan) and evidence.read(prefix + "ghdl-replay.txt") == content.encode(), "independently derived GHDL replay input")
    directory = prefix + "replay-vhdl/"
    flags = ["--std=08"] + (["-fpsl"] if psl else [])
    require(evidence.read(directory + "top.vhd") == source and evidence.read(directory + "formal-ghdl-input.txt") == content.encode()
            and digest(evidence.read(directory + "replay.vpi")) == plugin, "executed original VHDL, replay input and VPI bytes")
    analyze, run = evidence.data(directory + "analyze.json"), evidence.data(directory + "run.json")
    require(analyze["args"] == ["-a", *flags, "top.vhd"] and analyze["status"] == 0 and analyze["signal"] is None and analyze["error"] is None
            and not evidence.read(directory + "analyze.stdout") and not evidence.read(directory + "analyze.stderr"), "clean original VHDL analysis")
    require(run["args"] == ["--elab-run", *flags, "top", "--vpi=./replay.vpi", "--assert-level=none", "--backtrace-severity=note", "--psl-report=psl-report.json", "--vcd=formal-ghdl.vcd"]
            and run["command"] == analyze["command"] and run["command"].endswith("/ghdl-native/bin/ghdl"), "GHDL replay command")
    execution = evidence.data(directory + "execution.json")
    require(set(execution) == {"status", "elapsedMs"} and execution["status"] == run["status"] and TRACE.positive(execution["elapsedMs"]), "GHDL replay execution record")
    require(evidence.files(directory.rstrip("/")) == {"analyze.json", "analyze.stdout", "analyze.stderr", "execution.json", "formal-ghdl-input.txt", "formal-ghdl.vcd",
                                                      "psl-report.json", "replay.vpi", "run.json", "run.stdout", "run.stderr", "top.vhd", "verification.json", "work-obj08.cf"}, "complete GHDL replay inventory")
    stdout, stderr = evidence.read(directory + "run.stdout"), evidence.read(directory + "run.stderr")
    report, vcd = evidence.read(directory + "psl-report.json"), evidence.read(directory + "formal-ghdl.vcd")
    if run["status"] == 0 and run["signal"] is None and run["error"] is None:
        verification = verify_ghdl(gplan, stdout.decode("utf-8", errors="strict"), stderr.decode("utf-8", errors="strict"), report, vcd)
    else:
        verification = {"status": "rejected", "reason": "GHDL replay did not finish normally"}
    require(encoded(evidence.data(directory + "verification.json")) == encoded(verification), "GHDL verification derived from independent evidence")
    require(verification["status"] == expected, "expected original VHDL replay outcome")
    return {"runtime": "ghdl", "target": "vhdl", "expected": expected, "actual": verification["status"], "exitCode": run["status"], "elapsedMs": execution["elapsedMs"],
            "steps": plan["steps"], "failures": js_failures(verification.get("failures", []), ["id", "source", "step"]), "replaySha256": digest(content.encode()),
            "stdoutSha256": digest(stdout), "stderrSha256": digest(stderr), "vcdSha256": digest(vcd), "pslReportSha256": digest(report), "error": verification.get("reason")}


def audit_formal_inputs(evidence, meta, baseline):
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
            require(encoded(build) == encoded(meta["builds"][name]) and build["mode"] == runtime, "compiled tool provenance")
            artifacts = build["artifacts"] if tool == "iverilog" else {build["artifact"]["path"]: build["artifact"]}
            for path, artifact in artifacts.items():
                raw = evidence.read("inputs/" + name + "/" + path)
                require(digest(raw) == artifact["sha256"] and len(raw) == artifact.get("bytes", artifact.get("size")), "compiled tool bytes")
        native, wasi = (meta["builds"][tool + "-" + runtime] for runtime in ["native", "wasi"])
        key = "iverilog" if tool == "iverilog" else "source"
        require(native[key] == wasi[key], "matching simulator or synthesis source pin")
    require(meta["builds"]["yosys-native"]["artifact"]["sha256"] == baseline["yosys"]["sha256"] and meta["versions"]["yosys"] == baseline["yosys"]["version"], "executed baseline Yosys identity")
    ghdl = evidence.data("versions/ghdl-native.json")
    require(ghdl["status"] == 0 and ghdl["stdout"].split("\n")[0].strip() == meta["versions"]["ghdl"] == baseline["ghdl"]["version"], "actual GHDL version")
    require(digest(evidence.read("inputs/ghdl-native/ghdl")) == meta["ghdl"]["native"]["sha256"] == baseline["ghdl"]["sha256"], "executed native GHDL bytes")
    require(digest(evidence.read("inputs/ghdl-wasm/ghdl-synth.wasm")) == meta["ghdl"]["wasm"]["sha256"], "executed GHDL WASM bytes")
    require(digest(evidence.read("build/ghdl-wasm-build-manifest.tsv")) == meta["ghdl"]["wasmManifest"], "GHDL WASM build manifest")
    require(type(meta["ghdl"]["libraries"]) is dict and meta["ghdl"]["libraries"], "GHDL library inventory")


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
    for name, sha in meta["baselineHashes"].items():
        require(digest(evidence.read("baseline/" + name)) == sha, "native baseline hash")
    require(set(meta["baselineHashes"]) == {"metadata.json", "results.json"}, "complete native baseline hashes")
    baseline = evidence.data("baseline/metadata.json")
    require(encoded(meta["baseline"]) == encoded(baseline), "native baseline identity")
    require(not formal or baseline["worktree"] == "" and baseline["preliminary"] is False and baseline["commit"] == meta["commit"], "matching clean baseline")
    for name, sha in baseline["sources"].items():
        require(not formal or meta["snapshots"][name] == sha, "matching native source snapshot")
    if formal:
        audit_formal_inputs(evidence, meta, baseline)
    references = {(row["solver"], row["case"]): row for row in evidence.data("baseline/results.json")["rows"]}
    require(evidence.data("assets/manifest.json") == meta["assets"], "Python source manifest")
    for asset in meta["assets"]["assets"]:
        raw = evidence.read("assets/" + asset["path"])
        require(len(raw) == asset["size"] and digest(raw) == asset["sha256"], "Python source asset hash")
    plugin = evidence.data("build/ghdl-replay-plugin.json")
    require(digest(evidence.read("ghdl-replay-plugin/replay.vpi")) == plugin["sha256"], "built GHDL replay plugin")
    for phase in ["compile", "link"]:
        record = evidence.data(f"ghdl-replay-plugin/{phase}.json")
        require(record["status"] == 0 and record["signal"] is None and record["error"] is None, "clean GHDL replay plugin build")
    reader = csv.DictReader(io.StringIO(evidence.read("results.csv").decode()), strict=True)
    csv_rows = list(reader)
    require(reader.fieldnames == COLUMNS and result["columns"] == COLUMNS and len(csv_rows) == len(result["rows"]), "complete replay columns")
    derived, inventories, emitted = [], {}, {}
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
            spec, reference = FIXTURES[case], references[solver, case]
            phase = "basecase" if spec["mode"] == "prove" else "bmc"
            source = evidence.read("lowered/" + case + "/top.vhd") if (evidence.path("lowered/" + case)).exists() else None
            if reference.get("error") is not None:
                label = f"{solver}-{case}/"
                require(evidence.data(label + "upstream.json") == reference and spec["status"] == "FAIL" and reference["status"] == "ERROR"
                        and reference["expected"] == "FAIL" and reference["exitCode"] == 16, "upstream SBY error classification")
                engine = sorted(name for name in reference["files"] if re.fullmatch(r"result/engine_0/logfile[^/]*\.txt", name))
                files = {name: evidence.read(label + "baseline/" + name) for name in ["top.vhd", "top.v", *engine, "result/logfile.txt"]}
                require(engine and all(digest(raw) == reference["files"][name]["sha256"] for name, raw in files.items()), "retained upstream error logs")
                require(evidence.files(label.rstrip("/")) == {"upstream.json", *("baseline/" + name for name in files)}, "complete upstream error inventory")
                require(any(b"Traceback (most recent call last):" in files[name] for name in engine)
                        and files["result/logfile.txt"].rstrip().endswith(b"DONE (ERROR, rc=16)"), "upstream SMTBMC crash evidence")
                derived.append({"solver": solver, "case": case, "origin": "native", "runtime": "none", "target": "none", "phase": phase, "expected": "tool-error", "actual": "tool-error",
                                "exitCode": 16, "elapsedMs": reference["elapsedMs"], "sourceSha256": digest(files["top.vhd"]), "vhdlSha256": digest(files["top.vhd"]),
                                "loweredSha256": digest(files["top.v"]), "error": BASELINE_ERROR})
                continue
            require(source is not None and digest(source) == reference["files"]["top.vhd"]["sha256"], "original VHDL identity")
            lowered = evidence.read("lowered/" + case + "/top.v")
            require(digest(lowered) == reference["files"]["top.v"]["sha256"] and evidence.read("lowered/" + case + "/lower.stdout") == lowered
                    and evidence.read("lowered/" + case + "/wasm.v") == lowered and not evidence.read("lowered/" + case + "/lower.stderr")
                    and not evidence.read("lowered/" + case + "/analyze.stdout") and not evidence.read("lowered/" + case + "/analyze.stderr"), "native and WASM GHDL lowering identity")
            if case not in inventories:
                documents = []
                for runtime in ["native", "wasm"]:
                    require(evidence.read(f"{case}-inventory/{runtime}-inventory.ys") == SCRIPTS["inventory"].encode(), "inventory script")
                    documents.append(evidence.data(f"{case}-inventory/{runtime}.json"))
                    before = f"{case}-inventory/" + ("native/__formal/before.json" if runtime == "native" else "wasm-before.json")
                    require(evidence.read(before) == evidence.read(f"{case}-inventory/{runtime}.json"), "inventory output bytes")
                require(evidence.read(f"{case}-inventory/native/top.v") == lowered and without_creator(documents[0]) == without_creator(documents[1]), "native and WASI lowered inventory")
                inventories[case] = documents[0]
            document = inventories[case]
            module = document["modules"]["top"]
            base = {"solver": solver, "case": case, "phase": phase, "sourceSha256": digest(source), "vhdlSha256": digest(source), "loweredSha256": digest(lowered), "designSha256": digest(compact(document).encode())}
            if spec["status"] == "ERROR":
                label = f"{solver}-{case}/"
                require(evidence.read(label + "top.vhd") == source and evidence.read(label + "top.v") == lowered, "upstream tool-error sources")
                require(evidence.data(label + "upstream.json") == reference and reference["kind"] == "tool-error" and reference["exitCode"] != 0, "upstream vacuous assumption rejection")
                derived.append({**base, "origin": "native", "runtime": "none", "target": "none", "expected": "tool-error", "actual": "tool-error", "exitCode": reference["exitCode"], "elapsedMs": reference["elapsedMs"]})
                continue
            if case == "arbitrary-initial":
                try:
                    VERILOG.initialized_state(module)
                except ValueError as error:
                    require(str(error) == "fully initialized original registers", "independently classified unconstrained initial state")
                else:
                    require(False, "expected unconstrained initial state")
            if case == "no-property":
                require(not any(cell["type"] == "$assert" for cell in module["cells"].values()), "independent no-property boundary")
            if spec["status"] == "FAIL" and case not in emitted:
                pair = []
                for runtime in ["native", "wasm"]:
                    require(evidence.read(f"{case}-emit/{runtime}-emit.ys") == SCRIPTS["emit"].encode()
                            and evidence.read(f"{case}-emitted-{runtime}/{runtime}-inspect.ys") == SCRIPTS["inspect"].encode(), "emit and inspect scripts")
                    design = evidence.read(f"{case}-emit/{runtime}.v")
                    require(design == evidence.read(f"{case}-emit/" + ("native/__formal/replay-design.v" if runtime == "native" else "wasm-replay-design.v")), "emitted design output bytes")
                    raw = b"`timescale 1ns/1ps\n" + design
                    require(evidence.read(f"{case}-emitted-{runtime}/native/top.v") == raw, "inspected emitted design bytes")
                    before = f"{case}-emitted-{runtime}/" + ("native/__formal/before.json" if runtime == "native" else "wasm-before.json")
                    require(evidence.read(before) == evidence.read(f"{case}-emit/{runtime}.json"), "inspected emitted inventory bytes")
                    pair.append((raw, evidence.data(f"{case}-emit/{runtime}.json")))
                require(evidence.read(f"{case}-emit/native/top.v") == lowered, "emitted from lowered Verilog")
                banner = lambda raw: re.sub(rb"(?m)^/\* Generated by Yosys [^\n]*\n", b"", raw, count=1)
                require(banner(pair[0][0]) == banner(pair[1][0]) and without_creator(pair[0][1]) == without_creator(pair[1][1]), "native and WASI emitted replay design")
                emitted[case] = pair[0]
            no_trace, code = spec["status"] == "PASS", 0 if spec["status"] == "PASS" else 1
            first, captures, within = None, [], {}
            for origin in ["native", "pyodide"]:
                for entrypoint in ["smtbmc", "formal_trace"]:
                    prefix = f"{solver}-{case}/{origin}-{entrypoint}/"
                    process = evidence.data(prefix + "process.json")
                    require(process["status"] == "exited" and type(process["exitCode"]) is int and process["exitCode"] == code and TRACE.positive(process["elapsedMs"]), "normal lowered SMTBMC termination")
                    args = ["-s", "yices" if solver == "yices2" else solver, "--presat", "--noprogress"] + (["--unroll"] if solver == "yices2" else [])
                    args += ["-t", str(spec["depth"]), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"]
                    require(process["args"] == args and process.get("error") is None, "lowered SMTBMC argument and depth identity")
                    if origin == "pyodide":
                        require(process["integrityVerified"] is True, "verified Python assets")
                        TRACE.SOLVERS.audit_children(process["children"], solver, probe["wasi"]["artifact"]["sha256"], "bmc-safe" if no_trace else "bmc-violation", "bmc")
                    files = prefix + "files/"
                    names = ["top.v", "model.smt2"] + ([] if no_trace else ["trace.vcd", "trace.yw", "trace_tb.v"])
                    artifacts = {name: evidence.read(files + name) for name in names}
                    require(evidence.files(files.rstrip("/")) == set(names) | ({"formal-trace.json"} if entrypoint == "formal_trace" else set()), "complete SMTBMC artifact inventory")
                    model = artifacts["model.smt2"]
                    require(artifacts["top.v"] == lowered and digest(model) == reference["files"]["result/model/design_smt2.smt2"]["sha256"], "lowered source and prepared model identity")
                    stdout, stderr = evidence.read(prefix + "stdout.log"), evidence.read(prefix + "stderr.log")
                    require(not stderr and re.findall(rb"Status: (\w+)", stdout) == [b"PASSED" if no_trace else b"FAILED"], "SMTBMC status and diagnostics")
                    comparison = (re.sub(rb"^##\s+\d+:\d\d:\d\d\s+", b"## TIME ", stdout, flags=re.M), stderr, artifacts)
                    require(origin not in within or comparison == within[origin], "recording preserves all raw artifacts")
                    within[origin] = comparison
                    normalized = dict(artifacts)
                    if not no_trace:
                        normalized["trace_tb.v"] = VERILOG.normalize_tb(artifacts["trace_tb.v"].decode()).encode()
                    cross = (comparison[0], stderr, normalized)
                    require(first is None or cross == first, "cross-runtime artifact identity except PI ordering")
                    first = cross
                    if entrypoint != "formal_trace":
                        continue
                    sha, _ = TRACE.capture(evidence, files, code, digest(model), not no_trace)
                    capture = evidence.data(files + "formal-trace.json")
                    captures.append(evidence.read(files + "formal-trace.json"))
                    fields = {**base, "origin": origin, "modelSha256": digest(model), "captureSha256": sha, "sourceVcdSha256": digest(b"" if no_trace else artifacts["trace.vcd"])}
                    if spec["replay"] == "rejected":
                        require(evidence.data(prefix + "rejection.json") == {"reason": REJECTED[case]}, "unsupported replay rejection reason")
                        derived.append({**fields, "runtime": "none", "target": "none", "expected": "rejected", "actual": "rejected", "exitCode": code, "elapsedMs": process["elapsedMs"], "error": REJECTED[case]})
                        continue
                    plan, signals, values, observations = expected_plan(document, capture, case)
                    require(encoded(evidence.data(prefix + "plan.json")) == encoded(plan) and evidence.read(prefix + "replay.v") == plan["content"].encode(), "independently derived replay testbench")
                    bound = bind_lowered(plan, document, emitted[case][1])
                    require(encoded(evidence.data(prefix + "lowered-plan.json")) == encoded(bound), "independently derived lowered property mapping")
                    for runtime in ["native", "wasm"]:
                        derived.append({**fields, **lowered_result(evidence, f"{prefix}replay-lowered-{runtime}/", plan, bound, signals, values, observations, emitted[case][0])})
                    derived.append({**fields, **ghdl_result(evidence, prefix, plan, spec["psl"], source, plugin["sha256"], spec["vhdl"])})
            require(captures[0] == captures[1], "native and Pyodide capture bytes")
    expected_rows = [{name: row.get(name) for name in COLUMNS} for row in derived]
    require(TRACE.encoded(result["rows"]) == TRACE.encoded(expected_rows), "all JSON replay columns independently derived")
    for row, csv_row in zip(expected_rows, csv_rows, strict=True):
        require(csv_row == {key: "" if value is None else str(value) for key, value in row.items()}, "all CSV replay columns independently derived")
    return {"status": "pass", "rows": len(expected_rows), "columns": len(COLUMNS), "preliminary": not formal}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory")
    parser.add_argument("--formal", action="store_true")
    args = parser.parse_args()
    print(json.dumps(audit(args.directory, args.formal), sort_keys=True))
