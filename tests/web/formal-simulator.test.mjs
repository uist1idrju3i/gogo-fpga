import assert from "node:assert/strict";
import test from "node:test";
import { createFormalReplaySimulator } from "../../web/lib/formal-simulator.mjs";

test("formal replay simulates selected original sources and preserves its independent VCD", async () => {
  const bytes = new Uint8Array([1, 2]);
  let request;
  let stopped = 0;
  let disposed = 0;
  const simulate = createFormalReplaySimulator({ runner: {
    async run(input) { request = input; return { status: 0, stdout: "result", stderr: "", vcds: [{ name: "work/formal-replay.vcd", bytes }] }; },
    stop() { stopped++; }, dispose() { disposed++; },
  } });
  const replay = { path: "__formal/replay.v", content: "testbench" };
  const result = await simulate({ replay, sources: ["top.v"], files: new Map([["top.v", "original"], ["unselected.v", "ignored"]]), timeoutMs: 12 });
  assert.deepEqual(request, { files: [{ path: "top.v", content: "original" }, { path: replay.path, content: replay.content }],
    top: "__formal_replay", formal: true, timeLimitMs: 12, includeDirectories: [], defines: {} });
  assert.deepEqual(result, { status: 0, stdout: "result", stderr: "", vcd: bytes });
  simulate.cancel(); simulate.dispose();
  assert.equal(stopped, 1); assert.equal(disposed, 1);
});

test("formal replay refuses a missing original source and an absent independent waveform", async () => {
  const simulate = createFormalReplaySimulator({ runner: { async run() { return { status: 0, vcds: [] }; } } });
  await assert.rejects(simulate({ sources: ["missing.v"], files: new Map() }), /Missing replay source/);
  const result = await simulate({ replay: { path: "tb.v", content: "" }, sources: ["top.v"], files: new Map([["top.v", ""]]), timeoutMs: 10 });
  assert.equal(result.vcd, null);
});
