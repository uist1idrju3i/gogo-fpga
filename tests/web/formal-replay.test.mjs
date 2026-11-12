import assert from "node:assert/strict";
import test from "node:test";
import { createSatReplay, verifySatReplay } from "../../web/lib/formal-replay.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";

function fixture() {
  return {
    document: { modules: { top: {
      ports: { clk: { direction: "input", bits: [2] }, q: { direction: "output", bits: [3, 4] } },
      netnames: { q: { bits: [3, 4], attributes: { init: "00" } } },
      cells: {
        P: { type: "$assert", attributes: { src: "top.v:3.1-3.20" }, connections: { A: [5], EN: ["1"] } },
        state: { type: "$dff", parameters: { CLK_POLARITY: "1" }, connections: { CLK: [2], Q: [3, 4] } },
      },
    } } },
    top: "top", clock: "clk", depth: 4,
    witness: { signal: [{ name: "clk", wave: "40..." }, { name: "q", wave: "=.===", data: ["00", "01", "10", "11"] }] },
  };
}

function execution() {
  return { status: 0, stderr: "", vcd: "$timescale 1ps $end\n$scope module __formal_replay $end\n$enddefinitions $end\n#0\n$dumpvars\n$end\n#10000\n", stdout: [
    "FORMAL_REPLAY_DRIVE 1", "FORMAL_REPLAY_CHECK 1",
    "FORMAL_REPLAY_DRIVE 2", "FORMAL_REPLAY_CHECK 2",
    "FORMAL_REPLAY_DRIVE 3", "FORMAL_REPLAY_CHECK 3",
    "FORMAL_REPLAY_DRIVE 4", "ERROR: work/top.v:3: ", "       Time: 7000  Scope: __formal_replay.dut.P",
    "FORMAL_REPLAY_CHECK 4", "FORMAL_REPLAY_DONE",
  ].join("\n") };
}

test("replay uses the original initialized circuit and checks the model at every step", () => {
  const config = fixture();
  const saved = structuredClone(config);
  const replay = createSatReplay(config);
  assert.equal(replay.steps, 4);
  assert.match(replay.content, /2'b00/);
  assert.match(replay.content, /2'b11/);
  assert.match(replay.content, /!==/);
  assert.doesNotMatch(replay.content, /force|dut\.q\s*=/);
  assert.equal((replay.content.match(/p0 = 1'b1/g) ?? []).length, 3);
  assert.deepEqual(verifySatReplay(replay, execution()), {
    status: "verified", steps: 4, failures: [{ id: "P", step: 4, source: "top.v:3.1-3.20" }],
  });
  assert.deepEqual(config, saved);
});

test("replay refuses ambiguous, missing, unknown and malformed witness data", () => {
  const mutations = [
    (c) => { c.witness.signal.push(c.witness.signal[0]); },
    (c) => { c.witness.signal.pop(); },
    (c) => { c.witness.signal[1].wave = ".===="; },
    (c) => { c.witness.signal[1].wave = "=.=="; },
    (c) => { c.witness.signal[1].data[0] = "xx"; },
    (c) => { c.witness.signal[1].data.push("00"); },
    (c) => { c.witness.signal[1].data = []; },
    (c) => { c.witness.signal[1].data[1] = "0"; },
    (c) => { c.document.modules.top.ports.q.direction = "inout"; },
    (c) => { delete c.document.modules.top.netnames.q.attributes.init; },
    (c) => { c.document.modules.top.netnames.q.attributes.init = "xx"; },
    (c) => { c.depth = 3; },
    (c) => { c.depth = 1025; },
    (c) => { c.top = "top;exec"; },
    (c) => { c.document.modules.top.cells.extra = structuredClone(c.document.modules.top.cells.P); },
  ];
  for (const mutate of mutations) {
    const config = fixture();
    mutate(config);
    assert.throws(() => createSatReplay(config));
  }
});

test("replay rejects missing observations, assumptions, unknown diagnostics and normal runs without a violation", () => {
  const replay = createSatReplay(fixture());
  for (const mutate of [
    (e) => { e.status = 1; },
    (e) => { e.stderr = "warning"; },
    (e) => { e.vcd = ""; },
    (e) => { e.vcd = Uint8Array.of(255); },
    (e) => { e.vcd = e.vcd.replace("#10000", "#9000"); },
    (e) => { e.vcd = e.vcd.replace("#10000", "#5000\n#2000\n#10000"); },
    (e) => { e.vcd = e.vcd.replace("$timescale 1ps $end", ""); },
    (e) => { e.vcd = e.vcd.replace("$dumpvars", ""); },
    (e) => { e.stdout = e.stdout.replace("FORMAL_REPLAY_CHECK 4", ""); },
    (e) => { e.stdout += "\nFORMAL_REPLAY_DONE"; },
    (e) => { e.stdout = e.stdout.replace("ERROR: work/top.v:3: ", "ERROR: work/top.v:2: "); },
    (e) => { e.stdout = e.stdout.replace("ERROR: work/top.v:3: ", "FATAL: work/top.v:3: "); },
    (e) => { e.stdout = e.stdout.replace("ERROR: work/top.v:3: ", ""); },
    (e) => { e.stdout += "\nWARNING: unknown diagnostic"; },
    (e) => { e.stdout = e.stdout.replace("Time: 7000", "Unknown: 7000"); },
  ]) {
    const result = execution();
    mutate(result);
    assert.equal(verifySatReplay(replay, result).status, "rejected");
  }
  replay.locations[0].kind = "assume";
  assert.equal(verifySatReplay(replay, execution()).status, "rejected");
});

test("formal replay language mode is explicit and rejects truthy non-boolean flags", () => {
  for (const formal of ["true", 1, {}, null]) {
    assert.throws(() => runIverilog({ formal }), /must be boolean/);
  }
});
