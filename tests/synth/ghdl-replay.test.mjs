import assert from "node:assert/strict";
import test from "node:test";
import { createGhdlReplay, findPropertyInputs, verifyGhdlReplay } from "./ghdl-replay-helpers.mjs";

function fixture({ psl = false, edge = "posedge", trailing = false } = {}) {
  const property = { id: "p_bound", kind: "assert", source: psl ? "top.vhd:16.10-16.10" : "top.vhd:14.3-14.3" };
  const properties = [property, ...(trailing ? [{ id: "p_plain", kind: "assert", source: "top.vhd:14.3-14.3" }] : [])];
  const plan = createGhdlReplay({ steps: 4, clock: "clk", edge, properties,
    ports: [{ name: "clk", width: 1, direction: "input", values: [null, null, null, null] },
      { name: "a", width: 1, direction: "input", values: ["0", "0", "0", "0"] },
      { name: "q", width: 2, direction: "output", values: ["00", "01", "10", "11"] }] }, { top: "top", psl });
  const diagnostic = (type, line, column, ns, id) => `top.vhd:${line}:${column}:@${ns}ns:(${type} error): Assertion violation\n  instance: /top${type === "assertion" ? `/${id}` : ""}\n  from: process work.top(rtl).${id}\n`;
  let stdout = "FORMAL_GHDL_BEGIN 4 2 -15\n";
  for (const marker of plan.markers) {
    stdout += marker + "\n";
    if (!psl && marker === "FORMAL_GHDL_EDGE 4") stdout += diagnostic("assertion", 14, 3, 30, "p_bound");
    if (psl && marker === "FORMAL_GHDL_FLUSH") {
      stdout += diagnostic("psl assertion", 16, 10, 40, "p_bound");
      if (trailing) stdout += diagnostic("assertion", 14, 3, 40, "p_plain");
    }
  }
  const lines = ["$timescale 1 fs $end", "$scope module top $end", "$var reg 1 c clk $end", "$var reg 1 i a $end",
    "$var reg 2 o q[1:0] $end", "$upscope $end", "$enddefinitions $end", "#0", `${plan.inactive}c`, "0i", "b00 o"];
  for (let ns = 1; ns < plan.endTimeNs; ns++) {
    if (ns % 10 === 0) {
      lines.push(`#${ns * 1e6}`, `${1 - plan.inactive}c`, `b${(ns / 10 % 4).toString(2).padStart(2, "0")} o`);
    }
    if (ns % 10 === 5 && ns >= 15) lines.push(`#${ns * 1e6}`, `${plan.inactive}c`);
  }
  lines.push(`#${plan.endTimeNs * 1e6}`);
  const summary = Object.fromEntries(["assert", "assume", "cover"].flatMap((kind) =>
    [kind, `${kind}-failure`, `${kind}-pass`].map((key) => [key, 0])));
  if (psl) { summary.assert = 1; summary["assert-failure"] = 1; }
  const report = { details: psl ? [{ directive: "assertion", name: ".top(rtl).p_bound", file: "top.vhd", line: 16,
    "finished-count": 1, "started-count": 4, status: "failed" }] : [], summary };
  return { plan, execution: { status: 0, stdout, stderr: "loading VPI module './replay.vpi'\nVPI module loaded!\n",
    vcd: lines.join("\n") + "\n", pslReport: JSON.stringify(report) } };
}

test("GHDL verifier distinguishes plain assertions and PSL sampling on both edges", () => {
  for (const psl of [false, true]) for (const edge of ["posedge", "negedge"]) {
    const { plan, execution } = fixture({ psl, edge });
    const result = verifyGhdlReplay(plan, execution);
    assert.equal(result.status, "verified", result.reason);
    assert.deepEqual(result.failures, [{ id: "p_bound", source: plan.properties[0].source, step: 4 }]);
  }
});

test("terminal flush failures are retained but never counted as witness failures", () => {
  const { plan, execution } = fixture({ psl: true, trailing: true });
  const result = verifyGhdlReplay(plan, execution);
  assert.equal(result.status, "verified", result.reason);
  assert.equal(result.failures.length, 1);
  assert.equal(result.trailing.length, 1);
  assert.equal(result.trailing[0].step, 5);
  execution.stdout = execution.stdout.replace(/^top\.vhd:16.*\n  instance:.*\n  from:.*\n/m, "");
  const report = JSON.parse(execution.pslReport);
  report.details[0]["finished-count"] = 0;
  report.details[0].status = "passed";
  report.summary["assert-failure"] = 0;
  report.summary["assert-pass"] = 1;
  execution.pslReport = JSON.stringify(report);
  assert.equal(verifyGhdlReplay(plan, execution).status, "rejected");
});

const mutations = [
  ["nonzero exit", (execution) => { execution.status = 1; }],
  ["signal", (execution) => { execution.signal = "SIGKILL"; }],
  ["spawn error", (execution) => { execution.error = "timed out"; }],
  ["unexpected stderr", (execution) => { execution.stderr += "warning\n"; }],
  ["missing loader confirmation", (execution) => { execution.stderr = ""; }],
  ["missing startup", (execution) => { execution.stdout = execution.stdout.replace(/^.*\n/, ""); }],
  ["wrong precision", (execution) => { execution.stdout = execution.stdout.replace(" -15\n", " -14\n"); }],
  ["wrong port value marker", (execution) => { execution.stdout = execution.stdout.replace("O top.q 00", "O top.q 11"); }],
  ["missing observation", (execution) => { execution.stdout = execution.stdout.replace("FORMAL_GHDL_CHECK 2\n", ""); }],
  ["missing termination", (execution) => { execution.stdout = execution.stdout.replace("FORMAL_GHDL_DONE\n", ""); }],
  ["extra marker", (execution) => { execution.stdout += "FORMAL_GHDL_DONE\n"; }],
  ["missing assertion", (execution) => { execution.stdout = execution.stdout.replace(/^top\.vhd:14.*\n  instance:.*\n  from:.*\n/m, ""); }],
  ["wrong file", (execution) => { execution.stdout = execution.stdout.replace("top.vhd:14:", "other.vhd:14:"); }],
  ["wrong line", (execution) => { execution.stdout = execution.stdout.replace("top.vhd:14:", "top.vhd:13:"); }],
  ["wrong column", (execution) => { execution.stdout = execution.stdout.replace("top.vhd:14:3:", "top.vhd:14:4:"); }],
  ["wrong label", (execution) => { execution.stdout = execution.stdout.replace(".p_bound\n", ".wrong\n"); }],
  ["missing instance", (execution) => { execution.stdout = execution.stdout.replace("  instance: /top/p_bound\n", ""); }],
  ["wrong phase", (execution) => { execution.stdout = execution.stdout.replace("@30ns:", "@29ns:"); }],
  ["diagnostic after termination", (execution) => {
    const diagnostic = /^top\.vhd:14.*\n  instance:.*\n  from:.*\n/m.exec(execution.stdout)[0];
    execution.stdout = execution.stdout.replace(diagnostic, "") + diagnostic;
  }],
  ["unexpected report", (execution) => { execution.stdout = execution.stdout.replace("assertion error", "report error"); }],
  ["missing VCD", (execution) => { execution.vcd = ""; }],
  ["unsupported VCD variable", (execution) => { execution.vcd = execution.vcd.replace("$var reg 2", "$var real 2"); }],
  ["oversized VCD variable", (execution) => { execution.vcd = execution.vcd.replace("$var reg 2", "$var reg 999999999"); }],
  ["duplicate VCD time scale", (execution) => { execution.vcd = "$timescale 1 fs $end\n" + execution.vcd; }],
  ["unsupported VCD scope", (execution) => { execution.vcd = execution.vcd.replace("$scope module", "$scope function"); }],
  ["wrong VCD output", (execution) => { execution.vcd = execution.vcd.replace("b10 o", "b11 o"); }],
  ["unknown VCD output", (execution) => { execution.vcd = execution.vcd.replace("b10 o", "bxx o"); }],
  ["wrong VCD input", (execution) => { execution.vcd = execution.vcd.replace("0i", "1i"); }],
  ["wrong VCD clock", (execution) => { execution.vcd = execution.vcd.replace("1c", "0c"); }],
  ["missing VCD port", (execution) => { execution.vcd = execution.vcd.replace("q[1:0]", "other[1:0]"); }],
  ["unknown VCD variable", (execution) => { execution.vcd += "b00 undefined\n"; }],
  ["oversized VCD value", (execution) => { execution.vcd = execution.vcd.replace("b00 o", "b000 o"); }],
  ["truncated VCD", (execution) => { execution.vcd = execution.vcd.replace("#33000000\n", ""); }],
  ["backwards VCD time", (execution) => { execution.vcd = execution.vcd.replace("#20000000", "#14000000"); }],
  ["VCD invalid UTF-8", (execution) => { execution.vcd = Uint8Array.of(255); }],
  ["missing PSL report", (execution) => { execution.pslReport = ""; }],
  ["invalid PSL report summary", (execution) => { execution.pslReport = execution.pslReport.replace('"assert":0', '"assert":1'); }],
];
for (const [name, mutate] of mutations) test(`GHDL verifier rejects ${name}`, () => {
  const { plan, execution } = fixture();
  mutate(execution);
  assert.equal(verifyGhdlReplay(plan, execution).status, "rejected");
});

test("PSL report completeness and exact native counters fail closed", () => {
  for (const mutate of [
    (report) => { report.details[0]["finished-count"] = 2; },
    (report) => { report.details[0].status = "passed"; },
    (report) => { report.details[0].name = ".top(rtl).other"; },
    (report) => { report.details = []; report.summary = JSON.parse(fixture().execution.pslReport).summary; },
    (report) => { report.details.push(report.details[0]); report.summary.assert = 2; report.summary["assert-failure"] = 2; },
  ]) {
    const { plan, execution } = fixture({ psl: true });
    const report = JSON.parse(execution.pslReport);
    mutate(report);
    execution.pslReport = JSON.stringify(report);
    assert.equal(verifyGhdlReplay(plan, execution).status, "rejected");
  }
  for (const kind of ["assume", "cover"]) {
    const { plan, execution } = fixture({ psl: true });
    plan.properties.push({ id: "missing", kind, source: "top.vhd:18.10-18.10" });
    assert.equal(verifyGhdlReplay(plan, execution).status, "rejected");
  }
  const { plan, execution } = fixture({ psl: true });
  plan.properties.push({ ...plan.properties[0], id: "p_bound_cover", kind: "cover" });
  assert.equal(verifyGhdlReplay(plan, execution).status, "verified");
});

test("GHDL process source annotations must match the diagnostic exactly", () => {
  for (const annotation of [" at top.vhd:14", " at other.vhd:14", " at top.vhd:13"]) {
    const { plan, execution } = fixture();
    execution.stdout = execution.stdout.replace(".p_bound\n", `.p_bound${annotation}\n`);
    assert.equal(verifyGhdlReplay(plan, execution).status, annotation === " at top.vhd:14" ? "verified" : "rejected");
  }
});

test("property dependency cones stop at registers, but retain direct inputs", () => {
  const property = { id: "p" };
  const document = { modules: { top: {
    ports: { clk: { direction: "input", bits: [1] }, a: { direction: "input", bits: [2] } },
    cells: {
      p: { type: "$assert", connections: { A: [3], EN: ["1"] }, port_directions: { A: "input", EN: "input" } },
      state: { type: "$dff", connections: { CLK: [1], D: [2], Q: [3] }, port_directions: { CLK: "input", D: "input", Q: "output" } },
    },
  } } };
  assert.deepEqual(findPropertyInputs(document, "top", [property]), { p: [] });
  document.modules.top.cells.p.connections.A = [2];
  assert.deepEqual(findPropertyInputs(document, "top", [property]), { p: ["a"] });
  document.modules.top.cells.p.connections.A = [4];
  document.modules.top.cells.logic = { type: "$not", connections: { A: [2], Y: [4] }, port_directions: { A: "input", Y: "output" } };
  assert.deepEqual(findPropertyInputs(document, "top", [property]), { p: ["a"] });
  document.modules.top.cells.logic.connections.A = [4];
  assert.throws(() => findPropertyInputs(document, "top", [property]), /cycle/);
  document.modules.top.cells.logic.connections.A = [5];
  assert.throws(() => findPropertyInputs(document, "top", [property]), /Undriven/);
  document.modules.top.cells.logic.connections.A = ["x"];
  assert.throws(() => findPropertyInputs(document, "top", [property]), /Unknown/);
});
