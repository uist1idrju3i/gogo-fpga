import assert from "node:assert/strict";
import test from "node:test";
import { createBuildRunner } from "../../web/lib/build-runner.mjs";

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
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data });
    }
  }

  emitEvent(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  terminate() {
    this.terminated = true;
  }
}

function successfulBuild(worker) {
  worker.emit({ type: "progress", progress: { path: "yosys.wasm", loaded: 4, total: 8, cached: false } });
  worker.emit({ type: "tools_ready" });
  worker.emit({ type: "stage", stage: "synth" });
  worker.emit({
    type: "log",
    tool: "yosys",
    stream: "stdout",
    text: "synthesized",
  });
  worker.emit({
    type: "done",
    files: [
      { path: "build/top.json", bytes: Uint8Array.of(1) },
      { path: "build/top_pnr.json", bytes: Uint8Array.of(2) },
    ],
    timings: { synth: 10, pnr: 20 },
    memoryBytes: { yosys: 30, nextpnr: 40 },
  });
}

for (const [type, event, expected] of [
  ["error", { message: "worker stopped", filename: "build-worker.js", lineno: 12, colno: 3,
    error: new TypeError("allocation failed") }, /worker stopped; allocation failed; TypeError; build-worker.js:12:3/],
  ["error", { message: "", filename: "worker.js", lineno: 0, colno: 0,
    error: { name: "RuntimeError" } }, /RuntimeError; worker.js:0:0/],
  ["error", {}, /^Build worker failed$/],
  ["messageerror", { message: "invalid clone", filename: "worker.js", lineno: 4 }, /invalid clone; worker.js:4/],
  ["messageerror", {}, /^Build worker message could not be deserialized$/],
  ["message", { type: "error", stage: "synth", error: { name: "RangeError" }, filename: "yosys.js" }, /RangeError; yosys.js/],
  ["message", { type: "error", stage: "synth", message: "" }, /^Build worker failed$/],
  ["message", { type: "error", stage: "synth", message: "syntax error" }, /^syntax error$/],
]) {
  test(`${type} diagnostics are preserved: ${expected}`, async () => {
    let count = 0;
    let worker;
    const runner = createBuildRunner({
      createBuildWorker: () => {
        count += 1;
        worker = new FakeWorker(current => {
          if (type === "message") current.emit(event);
          else current.emitEvent(type, event);
        });
        return worker;
      },
      createPackWorker: () => { throw new Error("packing must not start"); },
    });
    await assert.rejects(runner.build({ files: [] }), error => {
      assert.match(error.message, expected);
      assert.equal(error.stage, event.stage);
      if (event.error instanceof Error) assert.equal(error.cause, event.error);
      return true;
    });
    assert.equal(count, 1);
    assert.equal(worker.terminated, true);
    for (const listeners of worker.listeners.values()) assert.equal(listeners.size, 0);
    assert.equal(runner.cancel(), false);
  });
}

test("build runner combines tool outputs and reuses its pack worker", async () => {
  let buildWorkerCount = 0;
  let packWorkerCount = 0;
  const stages = [];
  const logs = [];
  const progress = [];
  let ready = 0;
  const runner = createBuildRunner({
    createBuildWorker: () => {
      buildWorkerCount += 1;
      return new FakeWorker((worker) => successfulBuild(worker));
    },
    createPackWorker: () => {
      packWorkerCount += 1;
      return new FakeWorker((worker) => {
        worker.emit({ type: "stage", stage: "pack" });
        worker.emit({
          type: "done",
          files: [{ path: "build/top.fs", bytes: Uint8Array.of(3) }],
          timings: { pack: 5 },
          memoryBytes: { gowin_pack: 50 },
        });
      });
    },
  });

  const first = await runner.build(
    { board: "tangnano1k", top: "top", files: [] },
    {
      onStage: (stage) => stages.push(stage),
      onLog: (log) => logs.push(log),
      onProgress: (value) => progress.push(value),
      onToolsReady: () => { ready += 1; },
    },
  );
  const second = await runner.build({ board: "tangnano1k", top: "top", files: [] });

  assert.deepEqual(first.files.map(({ path }) => path), [
    "build/top.json",
    "build/top_pnr.json",
    "build/top.fs",
  ]);
  assert.deepEqual(first.timings, { synth: 10, pnr: 20, pack: 5 });
  assert.deepEqual(first.memoryBytes, {
    yosys: 30,
    nextpnr: 40,
    gowin_pack: 50,
  });
  assert.deepEqual(stages, ["synth", "pack"]);
  assert.deepEqual(progress, [{ path: "yosys.wasm", loaded: 4, total: 8, cached: false }]);
  assert.equal(ready, 1);
  assert.equal(logs[0].text, "synthesized");
  assert.equal(second.files.at(-1).path, "build/top.fs");
  assert.equal(buildWorkerCount, 2);
  assert.equal(packWorkerCount, 1);
  runner.dispose();
});

test("cancelling terminates both workers and the next build creates a pack worker", async () => {
  let buildWorkerCount = 0;
  let packWorkerCount = 0;
  const buildWorkers = [];
  const packWorkers = [];
  const runner = createBuildRunner({
    createBuildWorker: () => {
      buildWorkerCount += 1;
      const worker = new FakeWorker((current) => {
        if (buildWorkerCount > 1) successfulBuild(current);
      });
      buildWorkers.push(worker);
      return worker;
    },
    createPackWorker: () => {
      packWorkerCount += 1;
      const worker = new FakeWorker((current) => {
        current.emit({
          type: "done",
          files: [{ path: "build/top.fs", bytes: Uint8Array.of(3) }],
          timings: { pack: 1 },
          memoryBytes: { gowin_pack: 50 },
        });
      });
      packWorkers.push(worker);
      return worker;
    },
  });

  const pending = runner.build({ board: "tangnano1k", top: "top", files: [] });
  assert.equal(runner.cancel(), true);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(buildWorkers[0].terminated, true);

  const result = await runner.build({ board: "tangnano1k", top: "top", files: [] });
  assert.equal(result.files.at(-1).path, "build/top.fs");
  assert.equal(buildWorkerCount, 2);
  assert.equal(packWorkerCount, 1);
  assert.equal(packWorkers[0].terminated, false);
  runner.dispose();
});

test("cancelling a pack run discards the worker before the next build", async () => {
  let packWorkerCount = 0;
  const packWorkers = [];
  const runner = createBuildRunner({
    createBuildWorker: () =>
      new FakeWorker((worker) => successfulBuild(worker)),
    createPackWorker: () => {
      packWorkerCount += 1;
      const worker = new FakeWorker((current) => {
        if (packWorkerCount > 1) {
          current.emit({
            type: "done",
            files: [{ path: "build/top.fs", bytes: Uint8Array.of(3) }],
            timings: { pack: 1 },
            memoryBytes: { gowin_pack: 50 },
          });
        }
      });
      packWorkers.push(worker);
      return worker;
    },
  });

  const pending = runner.build({ board: "tangnano1k", top: "top", files: [] });
  await Promise.resolve();
  assert.equal(packWorkerCount, 1);
  assert.equal(runner.cancel(), true);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(packWorkers[0].terminated, true);

  const result = await runner.build({ board: "tangnano1k", top: "top", files: [] });
  assert.equal(result.files.at(-1).path, "build/top.fs");
  assert.equal(packWorkerCount, 2);
  assert.equal(packWorkers[1].terminated, false);
  runner.dispose();
});
