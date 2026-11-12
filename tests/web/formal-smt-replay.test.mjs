import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createSmtReplay } from "../../web/lib/formal-replay.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const model = new TextEncoder().encode("source-bound SMT model");
  const vcd = new TextEncoder().encode("upstream VCD bytes");
  return {
    document: { modules: { top: {
      ports: { clk: { direction: "input", bits: [2] }, q: { direction: "output", bits: [3, 4] } },
      netnames: { clk: { bits: [2] }, q: { bits: [3, 4], attributes: { init: "00" } }, hidden: { bits: [5] } },
      cells: {
        P: { type: "$assert", attributes: { src: "top.v:3.1-3.20" }, connections: { A: [5], EN: ["1"] } },
        state: { type: "$dff", parameters: { CLK_POLARITY: "1" }, connections: { CLK: [2], Q: [3, 4] } },
      },
    } } },
    top: "top", clock: "clk", depth: 6, model, vcd,
    capture: { format_version: 1, model: { path: "model.smt2", sha256: hash(model) }, upstreamExitCode: 1, traces: [{
      path: "trace.vcd", sha256: hash(vcd), endTime: 4,
      signals: [{ path: ["top", "clk"], width: 1, clock: "posedge" },
        { path: ["top", "q"], width: 2, clock: null }, { path: ["top", "hidden"], width: 1, clock: null }],
      steps: ["00", "01", "10", "11"].map((bits, time) => ({ time, values: [
        { path: ["top", "clk"], bits: "0" }, { path: ["top", "q"], bits }, { path: ["top", "hidden"], bits: "1" },
      ] })),
    }] },
  };
}

test("SMT replay keeps time zero, checks internal nets and never initializes DUT state", async () => {
  const config = fixture();
  const saved = structuredClone(config);
  const replay = await createSmtReplay(config);
  assert.equal(replay.steps, 4);
  assert.equal(replay.origin, "smt");
  assert.equal(replay.modelSha256, hash(config.model));
  assert.equal(replay.traceSha256, hash(config.vcd));
  assert.equal(replay.endTimeNs, 10);
  assert.deepEqual(replay.ports[1].values, ["00", "01", "10", "11"]);
  assert.equal((replay.content.match(/dut\.\\hidden /g) ?? []).length, 4);
  assert.equal((replay.content.match(/p0 = 1'b1/g) ?? []).length, 3);
  assert.doesNotMatch(replay.content, /force|dut\.\\q\s*=/);
  assert.deepEqual(config, saved);
  config.depth = 4;
  assert.equal((await createSmtReplay(config)).steps, 4);
  config.mode = "prove"; config.phase = "basecase";
  assert.equal((await createSmtReplay(config)).phase, "basecase");
});

test("SMT replay checks generated constant nets without referencing nonexistent HDL signals", async () => {
  const config = fixture();
  config.document.modules.top.netnames.hidden.bits = ["1"];
  const replay = await createSmtReplay(config);
  assert.doesNotMatch(replay.content, /dut\.\\hidden/);
  assert.match(replay.content, /if \(1'b1 !== 1'b1\)/);
});

test("SMT replay accepts only internal aliases of the verified clock bit", async () => {
  const config = fixture();
  config.document.modules.top.netnames["u.clk"] = { bits: [2] };
  const trace = config.capture.traces[0];
  trace.signals.push({ path: ["top", "u", "clk"], width: 1, clock: "posedge" });
  for (const step of trace.steps) step.values.push({ path: ["top", "u", "clk"], bits: "0" });
  const replay = await createSmtReplay(config);
  assert.doesNotMatch(replay.content, /dut\.\\u \.\\clk/);
  config.document.modules.top.netnames["u.clk"].bits = [6];
  await assert.rejects(createSmtReplay(config), /differs from original design or clock/);
});

test("SMT replay refuses invalid provenance, schema, ports, clocks, samples and initial states", async t => {
  const mutations = {
    "wrong model bytes": c => { c.model[0] ^= 1; },
    "wrong VCD bytes": c => { c.vcd[0] ^= 1; },
    "missing model": c => { delete c.model; },
    "missing VCD": c => { delete c.vcd; },
    "missing capture": c => { delete c.capture; },
    "wrong format": c => { c.capture.format_version = 2; },
    "extra record key": c => { c.capture.matched = true; },
    "normal cover exit": c => { c.capture.upstreamExitCode = 0; },
    "induction": c => { c.mode = "prove"; c.phase = "induction"; },
    "cover": c => { c.mode = "cover"; c.phase = "cover"; },
    "wrong basecase mode": c => { c.mode = "prove"; },
    "duplicate trace": c => { c.capture.traces.push(c.capture.traces[0]); },
    "missing trace": c => { c.capture.traces = []; },
    "unsafe model path": c => { c.capture.model.path = "../model.smt2"; },
    "drive-qualified model path": c => { c.capture.model.path = "C:model.smt2"; },
    "NUL model path": c => { c.capture.model.path = "model\0.smt2"; },
    "reserved model path": c => { c.capture.model.path = "formal-trace.json"; },
    "unsafe trace path": c => { c.capture.traces[0].path = "/trace.vcd"; },
    "reserved trace path": c => { c.capture.traces[0].path = "formal-trace.json"; },
    "overlapping trace path": c => { c.capture.traces[0].path = "model.smt2"; },
    "invalid top": c => { c.top = "top;exec"; },
    "missing top": c => { c.top = "absent"; },
    "N-1 depth": c => { c.depth = 3; },
    "string depth": c => { c.depth = "6"; },
    "zero depth": c => { c.depth = 0; },
    "excessive depth": c => { c.depth = 1025; },
    "missing initialization": c => { delete c.document.modules.top.netnames.q.attributes.init; },
    "unknown initialization": c => { c.document.modules.top.netnames.q.attributes.init = "xx"; },
    "wrong concrete initial sample": c => { c.capture.traces[0].steps[0].values[1].bits = "01"; },
    "wrong edge": c => { c.edge = "negedge"; },
    "wrong captured clock edge": c => { c.capture.traces[0].signals[0].clock = "negedge"; },
    "unclocked state": c => { c.clock = null; },
    "additional clock": c => { c.capture.traces[0].signals[2].clock = "posedge"; },
    "missing port": c => { delete c.document.modules.top.netnames.q; },
    "inout port": c => { c.document.modules.top.ports.q.direction = "inout"; },
    "wrong port bits": c => { c.document.modules.top.ports.q.bits = [4, 3]; },
    "wrong width": c => { c.capture.traces[0].signals[1].width = 3; },
    "duplicate signal": c => { c.capture.traces[0].signals.push(c.capture.traces[0].signals[1]); },
    "invalid signal path": c => { c.capture.traces[0].signals[2].path[1] = "q); $finish;"; },
    "wrong signal top": c => { c.capture.traces[0].signals[2].path[0] = "other"; },
    "unknown internal signal": c => { delete c.document.modules.top.netnames.hidden; },
    "unknown value": c => { c.capture.traces[0].steps[1].values[1].bits = "x1"; },
    "wrong value width": c => { c.capture.traces[0].steps[1].values[1].bits = "1"; },
    "duplicate sample value": c => { c.capture.traces[0].steps[1].values[1] = c.capture.traces[0].steps[1].values[2]; },
    "missing sample value": c => { c.capture.traces[0].steps[1].values.pop(); },
    "missing time zero": c => { c.capture.traces[0].steps.shift(); c.capture.traces[0].endTime--; },
    "duplicate sample time": c => { c.capture.traces[0].steps[1].time = 0; },
    "incomplete end time": c => { c.capture.traces[0].endTime--; },
    "unknown state kind": c => { c.document.modules.top.cells.state.type = "$mem_v2"; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const config = fixture();
    mutate(config);
    await assert.rejects(createSmtReplay(config));
  });
});
