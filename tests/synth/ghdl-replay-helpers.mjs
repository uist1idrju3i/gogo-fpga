import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyGhdlReplayVcd } from "./ghdl-replay-vcd.mjs";
import { getVhdlLibrary } from "../../web/lib/vhdl-order.mjs";

const identifier = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function createGhdlReplay(replay, { top, psl = false, document } = {}) {
  assert.ok(identifier.test(top) && typeof psl === "boolean", "Unsupported GHDL replay top or language mode");
  assert.ok(!psl || replay.clock, "Clocked PSL replay requires a clock");
  assert.ok(!replay.clock || identifier.test(replay.clock), "Unsupported GHDL replay clock");
  const ports = replay.ports.filter(({ name }) => name !== replay.clock);
  assert.ok(ports.length > 0 && ports.every(({ name }) => identifier.test(name)), "Unsupported GHDL replay ports");
  const inactive = replay.edge === "posedge" ? 0 : 1;
  const lines = [`FORMAL_GHDL_V1 ${replay.steps} ${ports.length} ${psl ? 1 : 0} ${inactive} ${replay.clock ? `${top}.${replay.clock}` : "-"}`];
  const markers = [], markerTimesNs = [];
  const mark = (text, ns) => { markers.push(text); markerTimesNs.push(ns); };
  for (let step = 0; step < replay.steps; step++) {
    if (step && replay.clock) mark(`FORMAL_GHDL_EDGE ${step + 1}`, 10 * step);
    lines.push(`STEP ${step + 1}`);
    mark(`FORMAL_GHDL_DRIVE ${step + 1}`, 10 * step + (step ? 1 : 0));
    for (const port of ports) {
      const value = `${port.direction === "input" ? "I" : "O"} ${top}.${port.name} ${port.values[step]}`;
      lines.push(value);
      mark(`FORMAL_GHDL_PORT ${step + 1} ${value}`, 10 * step + 2);
    }
    mark(`FORMAL_GHDL_CHECK ${step + 1}`, 10 * step + 2);
  }
  if (psl) mark("FORMAL_GHDL_FLUSH", 10 * replay.steps);
  const endTimeNs = psl ? 10 * replay.steps + 1 : 10 * (replay.steps - 1) + 3;
  mark("FORMAL_GHDL_DONE", endTimeNs);
  const propertyInputs = document ? findPropertyInputs(document, top, replay.properties) : undefined;
  return { ...replay, top, psl, ports, inactive, content: `${lines.join("\n")}\n`, markers, markerTimesNs, endTimeNs, propertyInputs };
}

export function findPropertyInputs(document, top, properties) {
  const module = document.modules[top];
  const inputs = new Map();
  const drivers = new Map();
  for (const [name, port] of Object.entries(module.ports)) if (port.direction === "input") {
    for (const bit of port.bits) inputs.set(bit, [...(inputs.get(bit) ?? []), name]);
  }
  for (const cell of Object.values(module.cells)) for (const [port, bits] of Object.entries(cell.connections)) {
    assert.ok(["input", "output"].includes(cell.port_directions?.[port]), "Missing property dependency direction");
    if (cell.port_directions[port] !== "output") continue;
    for (const bit of bits) {
      assert.ok(!drivers.has(bit), "Multiple property dependency drivers");
      drivers.set(bit, cell);
    }
  }
  function visit(bit, active, found) {
    if (["0", "1"].includes(bit)) return;
    assert.ok(Number.isSafeInteger(bit) && bit >= 0, "Unknown property dependency value");
    if (inputs.has(bit)) { for (const name of inputs.get(bit)) found.add(name); return; }
    assert.ok(!active.has(bit), "Combinational property dependency cycle");
    const cell = drivers.get(bit);
    assert.ok(cell, "Undriven property dependency");
    if (cell.type === "$dff") return;
    assert.ok(!/^\$(?:.*ff|.*latch|mem|anyinit|sr$)/i.test(cell.type), "Unsupported property dependency state");
    const next = new Set(active).add(bit);
    for (const [port, bits] of Object.entries(cell.connections)) if (cell.port_directions[port] === "input") {
      for (const dependency of bits) visit(dependency, next, found);
    }
  }
  return Object.fromEntries(properties.map(({ id }) => {
    const cell = module.cells[id];
    assert.ok(cell && ["$assert", "$assume", "$cover"].includes(cell.type), "Missing property dependency target");
    const found = new Set();
    for (const port of ["A", "EN"]) for (const bit of cell.connections[port]) visit(bit, new Set(), found);
    return [id, [...found].sort()];
  }));
}

function timeNs(digits, unit) {
  const value = Number(digits) * 10 ** ({ fs: -6, ps: -3, ns: 0, us: 3, ms: 6, sec: 9 }[unit]);
  assert.ok(Number.isSafeInteger(value) && value >= 0, "Unaligned or invalid diagnostic time");
  return value;
}

function propertyAt(plan, file, line, kind) {
  const found = plan.properties.filter((property) => property.kind === kind &&
    new RegExp(`^${line}\\.`).test(property.source.slice(property.source.lastIndexOf(":") + 1)) &&
    property.source.slice(0, property.source.lastIndexOf(":")) === file);
  assert.equal(found.length, 1, "Unknown or ambiguous original VHDL property");
  return found[0];
}

function verifyPslReport(plan, raw, diagnostics) {
  const report = JSON.parse(typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw));
  assert.ok(Array.isArray(report.details) && report.summary && typeof report.summary === "object", "Missing PSL report");
  const totals = Object.fromEntries(["assert", "assume", "cover"].flatMap((type) => [type, `${type}-failure`, `${type}-pass`].map((key) => [key, 0])));
  const seen = new Set();
  for (const detail of report.details) {
    const kind = { assertion: "assert", assumption: "assume", cover: "cover" }[detail.directive];
    assert.ok(plan.psl && kind && typeof detail.name === "string" && !seen.has(detail.name), "Unexpected or duplicate PSL directive");
    seen.add(detail.name);
    assert.ok(Number.isSafeInteger(detail.line) && detail.line > 0 &&
      [detail["finished-count"], detail["started-count"]].every((value) => Number.isSafeInteger(value) && value >= 0), "Invalid PSL counters");
    const property = propertyAt(plan, detail.file, detail.line, kind);
    assert.ok(detail.name.startsWith(`.${plan.top}(`) && detail.name.endsWith(`.${property.id}`), "PSL report property label mismatch");
    const finished = detail["finished-count"];
    assert.equal(detail.status, kind === "cover" ? finished ? "covered" : "not covered" : finished ? "failed" : "passed", "PSL status and counter disagree");
    const diagnosticCount = diagnostics.filter((event) => event.psl && event.id === property.id).length;
    if (kind === "cover") assert.equal(diagnosticCount, 0, "Unexpected cover diagnostic without a cover-report option");
    else assert.equal(diagnosticCount, finished, "PSL report and diagnostic count disagree");
    totals[kind]++;
    totals[`${kind}-${kind === "cover" ? finished > 0 ? "pass" : "failure" : finished > 0 ? "failure" : "pass"}`]++;
    assert.ok(kind !== "assume" || finished === 0, "Original VHDL violated an assumption");
  }
  assert.deepEqual(report.summary, totals, "PSL summary and details disagree");
  for (const property of plan.properties.filter(({ kind }) => kind !== "assert")) {
    if (property.kind === "cover" && plan.properties.some((other) => other.kind === "assert" &&
        `${other.id}_cover` === property.id && other.source === property.source)) continue;
    assert.ok(report.details.some((detail) => detail.name.endsWith(`.${property.id}`) &&
      propertyAt(plan, detail.file, detail.line, property.kind).id === property.id), "PSL report omitted an assumption or explicit cover");
  }
  for (const diagnostic of diagnostics.filter(({ psl }) => psl)) {
    assert.ok(report.details.some((detail) => detail.file === diagnostic.path && detail.line === diagnostic.line), "PSL report omitted a diagnostic");
  }
  return report;
}

export function verifyGhdlReplay(plan, execution) {
  try {
    assert.ok(execution?.status === 0 && !execution.signal && !execution.error, "GHDL replay did not finish normally");
    assert.equal(execution.stderr, "loading VPI module './replay.vpi'\nVPI module loaded!\n", "Unexpected GHDL stderr diagnostic");
    assert.equal(typeof execution.stdout, "string", "Missing GHDL stdout");
    const lines = execution.stdout.trimEnd().split(/\r?\n/);
    const begin = /^FORMAL_GHDL_BEGIN (\d+) (\d+) (-\d+)$/.exec(lines.shift());
    assert.ok(begin && Number(begin[1]) === plan.steps && Number(begin[2]) === plan.ports.length &&
      Number(begin[3]) >= -15 && Number(begin[3]) <= -9, "Missing GHDL startup marker");
    const observed = [], diagnostics = [], failures = [], trailing = [];
    const designFiles = new Set(plan.properties.map((property) => property.source.slice(0, property.source.lastIndexOf(":"))));
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.startsWith("FORMAL_GHDL_")) { observed.push(line); continue; }
      const match = /^([^:]+):(\d+):(\d+):@(\d+)(fs|ps|ns|us|ms|sec):\((assertion|psl assertion|psl assumption|psl cover) (note|warning|error|failure)\): (.*)$/.exec(line);
      assert.ok(match, "Unknown original VHDL diagnostic");
      const [, file, sourceLine, column, digits, unit, type] = match;
      const kind = type === "psl cover" ? "cover" : type === "psl assumption" ? "assume" : "assert";
      if (!designFiles.has(file)) {
        // Library-internal diagnostics (e.g. NUMERIC_STD metavalue warnings) are
        // not design properties; skip their instance/from continuation lines.
        while (lines[index + 1]?.startsWith("  instance:") || lines[index + 1]?.startsWith("  from:")) index++;
        continue;
      }
      const property = propertyAt(plan, file, Number(sourceLine), kind);
      assert.ok(property.source.startsWith(`${file}:${sourceLine}.${column}-`), "Original VHDL diagnostic column mismatch");
      const instance = new RegExp(`^  instance: (/${plan.top}(?:/[a-z0-9_/]+)?)$`).exec(lines[++index] ?? "");
      const dotted = "/" + property.id.replaceAll(".", "/");
      assert.ok(instance && (instance[1] === `/${plan.top}` || instance[1].endsWith(dotted)), "Missing or mismatched VHDL diagnostic instance");
      if (lines[index + 1]?.startsWith("  from: process ")) {
        const origin = lines[++index];
        const annotation = / at ([^:\r\n]+):(\d+)$/.exec(origin);
        if (annotation) assert.ok(annotation[1] === file && Number(annotation[2]) === Number(sourceLine), "Original VHDL process source mismatch");
        const process = annotation ? origin.slice(0, annotation.index) : origin;
        assert.ok(process.endsWith(`.${property.id.split(".").at(-1)}`), "Original VHDL diagnostic label mismatch");
      }
      const ns = timeNs(digits, unit), psl = type.startsWith("psl ");
      assert.ok(observed.length > 0 && observed.length < plan.markers.length &&
        ns >= plan.markerTimesNs[observed.length - 1] && ns <= plan.markerTimesNs[observed.length], "Diagnostic is outside its replay marker phase");
      assert.ok(ns <= plan.endTimeNs && (!psl || plan.psl && ns > 0 && ns % 10 === 0), "Unexpected original VHDL diagnostic phase");
      if (psl) assert.match(observed.at(-1), /^FORMAL_GHDL_(EDGE \d+|FLUSH)$/, "PSL diagnostic did not follow its sampling edge");
      const step = psl ? ns / 10 : Math.floor(ns / 10) + 1;
      const event = { id: property.id, kind, path: file, line: Number(sourceLine), source: property.source, ns, step, psl };
      diagnostics.push(event);
      assert.notEqual(kind, "assume", "Original VHDL violated an assumption");
      if (step > plan.steps) {
        assert.ok(plan.psl && !psl && ns === 10 * plan.steps, "Unexpected post-witness diagnostic");
        trailing.push(event);
      } else if (kind === "assert") {
        if (!psl && step > 1 && ns % 10 < 1) {
          const relevant = plan.propertyInputs?.[property.id];
          assert.ok(plan.ports.every((port) => port.direction !== "input" || relevant && !relevant.includes(port.name) ||
            port.values[step - 1] === port.values[step - 2]), "Ambiguous assertion during an input transition");
        }
        failures.push({ id: property.id, source: property.source, step });
      }
    }
    assert.deepEqual(observed, plan.markers, "Incomplete or inconsistent GHDL replay markers");
    assert.ok(failures.length > 0, "Original VHDL did not reproduce an assertion failure within the witness");
    const pslReport = verifyPslReport(plan, execution.pslReport, diagnostics);
    const { ticksPerNs } = verifyGhdlReplayVcd(plan, execution.vcd);
    assert.equal(ticksPerNs, 10 ** (-9 - Number(begin[3])), "VCD and VPI time precision disagree");
    return { status: "verified", steps: plan.steps, failures, trailing, diagnostics, pslReport };
  } catch (error) {
    return { status: "rejected", reason: String(error.message ?? error) };
  }
}

function runRecorded(command, args, directory, phase) {
  const started = performance.now();
  const execution = spawnSync(command, args, { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(path.join(directory, `${phase}.stdout`), execution.stdout ?? "", { flag: "wx" });
  writeFileSync(path.join(directory, `${phase}.stderr`), execution.stderr ?? "", { flag: "wx" });
  writeFileSync(path.join(directory, `${phase}.json`), JSON.stringify({ command, args, status: execution.status,
    signal: execution.signal, error: execution.error?.message ?? null, elapsedMs: performance.now() - started }, null, 2), { flag: "wx" });
  return execution;
}

export function buildGhdlReplayPlugin(native, directory) {
  mkdirSync(directory);
  const source = path.resolve(import.meta.dirname, "ghdl-replay-vpi.c");
  for (const [phase, args] of [
    ["compile", ["--vpi-compile", "gcc", "-Wall", "-Wextra", "-Werror", "-std=c11", "-c", source, "-o", "replay.o"]],
    ["link", ["--vpi-link", "gcc", "-o", "replay.vpi", "replay.o"]],
  ]) {
    const result = runRecorded(native, args, directory, phase);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  return path.join(directory, "replay.vpi");
}

export function runGhdlReplay({ native, plugin, directory, source, plan, dependencies = [] }) {
  const started = performance.now();
  mkdirSync(directory);
  writeFileSync(path.join(directory, "top.vhd"), source, { flag: "wx" });
  writeFileSync(path.join(directory, "formal-ghdl-input.txt"), plan.content, { flag: "wx" });
  copyFileSync(plugin, path.join(directory, "replay.vpi"));
  const flags = ["--std=08", ...(plan.psl ? ["-fpsl"] : [])];
  for (const [index, file] of dependencies.entries()) {
    assert.ok(file.path && path.basename(file.path) === file.path && file.path !== "top.vhd", "Unsupported replay dependency path");
    writeFileSync(path.join(directory, file.path), file.content, { flag: "wx" });
    const analyzed = runRecorded(native, ["-a", ...flags, `--work=${getVhdlLibrary(file)}`, file.path], directory, `dependency-${index}`);
    assert.ifError(analyzed.error);
    assert.equal(analyzed.status, 0, analyzed.stderr);
    assert.equal(analyzed.stdout + analyzed.stderr, "", "Unexpected replay dependency diagnostic");
  }
  const analysis = runRecorded(native, ["-a", ...flags, "top.vhd"], directory, "analyze");
  assert.ifError(analysis.error);
  assert.equal(analysis.status, 0, analysis.stderr);
  assert.equal(analysis.stdout + analysis.stderr, "", "Unexpected original VHDL analysis diagnostic");
  const execution = runRecorded(native, ["--elab-run", ...flags, plan.top, "--vpi=./replay.vpi", "--assert-level=none",
    "--backtrace-severity=note", "--psl-report=psl-report.json", "--vcd=formal-ghdl.vcd"], directory, "run");
  const read = (name) => { try { return readFileSync(path.join(directory, name)); } catch { return new Uint8Array(); } };
  return { status: execution.status, signal: execution.signal, error: execution.error?.message ?? null, elapsedMs: performance.now() - started,
    stdout: execution.stdout, stderr: execution.stderr, vcd: read("formal-ghdl.vcd"), pslReport: read("psl-report.json") };
}
