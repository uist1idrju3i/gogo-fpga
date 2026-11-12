import assert from "node:assert/strict";
import test from "node:test";
import { createSimRunner, extractVcd, NO_VCD_MESSAGE, vcdRootScopes } from "../../web/lib/sim-runner.mjs";

test("waveform scope selection follows the VCD rather than the simulation module", () => {
  const header = [
    "$comment mention $scope module ignored $end",
    "$scope module logic $end",
    "$scope module nested $end",
    "$upscope $end",
    "$upscope $end",
    "$scope module other $end",
    "$upscope $end",
    "$enddefinitions $end",
    "$scope module not_a_header $end",
  ].join("\n");
  assert.deepEqual(vcdRootScopes(new TextEncoder().encode(header)), ["logic", "other"]);
  assert.deepEqual(vcdRootScopes(Uint8Array.of(1)), []);
});

class FakeWorker {
  constructor(onPostMessage) {
    this.onPostMessage = onPostMessage;
    this.listeners = new Map();
    this.terminated = false;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message) {
    this.onPostMessage?.(this, message);
  }

  emit(data) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }

  terminate() {
    this.terminated = true;
  }
}

function completedResult(worker, result = {}) {
  worker.emit({ type: "started" });
  worker.emit({
    type: "done",
    result: {
      status: 0,
      stdout: "",
      stderr: "",
      diagnosticText: [],
      tree: { "wave.vcd": Uint8Array.of(1, 2, 3) },
      ...result,
    },
  });
}

const files = [{ path: "src/top.v", content: "module top; endmodule\n" }];

test("VCD extraction keeps every output and prefers wave.vcd initially", () => {
  const extracted = extractVcd({
    "z.vcd": Uint8Array.of(3),
    sim: { "wave.vcd": Uint8Array.of(1), "a.vcd": Uint8Array.of(2) },
  });
  assert.equal(extracted.vcd.name, "sim/wave.vcd");
  assert.deepEqual([...extracted.vcd.bytes], [1]);
  assert.deepEqual(extracted.vcds.map(({ name }) => name), ["sim/a.vcd", "sim/wave.vcd", "z.vcd"]);
  assert.equal(extracted.vcd, extracted.vcds[1]);
  assert.deepEqual(extractVcd({ work: { "top.v": "module top;" } }), {
    vcd: null,
    vcds: [],
  });
});

test("VCD extraction preserves same basenames in separate directories", () => {
  const extracted = extractVcd({
    a: { "result.VCD": Uint8Array.of(1), "ignored.txt": Uint8Array.of(0) },
    b: { "result.VCD": Uint8Array.of(2).buffer },
  });
  assert.deepEqual(extracted.vcds.map(({ name }) => name), ["a/result.VCD", "b/result.VCD"]);
  assert.equal(extracted.vcd.name, "a/result.VCD");
  assert.deepEqual([...extracted.vcds[1].bytes], [2]);
});

test("successful simulations expose all VCD files without discarding any", async () => {
  const runner = createSimRunner({
    createSimWorker: () => new FakeWorker((worker) => completedResult(worker, {
      tree: { "wave.vcd": Uint8Array.of(1), "other.vcd": Uint8Array.of(2) },
    })),
  });
  const result = await runner.run({ files, top: "top", timeLimitMs: 100 });
  assert.equal(result.outcome, "ok");
  assert.equal(result.vcd.name, "wave.vcd");
  assert.deepEqual(result.vcds.map(({ name }) => name), ["other.vcd", "wave.vcd"]);
  assert.equal(result.stdout, "");
  runner.dispose();
});

test("a successful simulator exit without VCD is a failure", async () => {
  const runner = createSimRunner({
    createSimWorker: () =>
      new FakeWorker((worker) => completedResult(worker, { tree: {} })),
  });
  const result = await runner.run({ files, top: "top", timeLimitMs: 100 });
  assert.equal(result.outcome, "failed");
  assert.equal(result.status, 0);
  assert.match(result.stderr, new RegExp(NO_VCD_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(result.diagnostics.at(-1).message, NO_VCD_MESSAGE);
  runner.dispose();
});

test("stopping terminates the worker and the next run creates a fresh worker", async () => {
  const workers = [];
  const runner = createSimRunner({
    createSimWorker: () => {
      const worker = new FakeWorker((current) => {
        if (workers.length > 1) completedResult(current);
      });
      workers.push(worker);
      return worker;
    },
  });
  const pending = runner.run({ files, top: "top", timeLimitMs: 1_000 });
  assert.equal(runner.stop(), true);
  assert.equal((await pending).outcome, "stopped");
  assert.equal(workers[0].terminated, true);
  assert.equal((await runner.run({ files, top: "top", timeLimitMs: 1_000 })).outcome, "ok");
  assert.equal(workers.length, 2);
  assert.equal(workers[1].terminated, false);
  runner.dispose();
});

test("timeout terminates the worker and the next run creates a fresh worker", async () => {
  const workers = [];
  const runner = createSimRunner({
    createSimWorker: () => {
      const worker = new FakeWorker((current) => {
        if (workers.length > 1) completedResult(current);
        else current.emit({ type: "started" });
      });
      workers.push(worker);
      return worker;
    },
  });
  const timedOut = await runner.run({ files, top: "top", timeLimitMs: 5 });
  assert.equal(timedOut.outcome, "timeout");
  assert.equal(workers[0].terminated, true);
  assert.equal((await runner.run({ files, top: "top", timeLimitMs: 1_000 })).outcome, "ok");
  assert.equal(workers.length, 2);
  runner.dispose();
});

test("simulation time limit starts after the worker reports loaded modules", async () => {
  const runner = createSimRunner({
    moduleLoadTimeoutMs: 1_000,
    createSimWorker: () =>
      new FakeWorker((worker) => {
        setTimeout(() => completedResult(worker), 40);
      }),
  });
  const result = await runner.run({ files, top: "top", timeLimitMs: 10 });
  assert.equal(result.outcome, "ok");
  runner.dispose();
});

test("module load timeout reports a load failure and terminates the worker", async () => {
  let worker;
  const runner = createSimRunner({
    moduleLoadTimeoutMs: 5,
    createSimWorker: () => {
      worker = new FakeWorker();
      return worker;
    },
  });
  const result = await runner.run({ files, top: "top", timeLimitMs: 1_000 });
  assert.equal(result.outcome, "failed");
  assert.match(result.stderr, /Icarus WASM module loading timed out/);
  assert.equal(worker.terminated, true);
  runner.dispose();
});

test("simulation diagnostics map tool paths back to project files", async () => {
  const runner = createSimRunner({
    createSimWorker: () =>
      new FakeWorker((worker) =>
        completedResult(worker, {
          diagnosticText: [{ tool: "ivl", text: "work/src/top.v:3: syntax error\n" }],
        })
      ),
  });
  const result = await runner.run({ files, top: "top", timeLimitMs: 100 });
  assert.deepEqual(result.diagnostics, [{
    file: "src/top.v",
    line: 3,
    severity: "error",
    message: "syntax error",
  }]);
  runner.dispose();
});
