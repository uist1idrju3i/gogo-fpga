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

  terminate() {
    this.terminated = true;
  }
}

function successfulBuild(worker) {
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

test("build runner combines tool outputs and reuses its pack worker", async () => {
  let buildWorkerCount = 0;
  let packWorkerCount = 0;
  const stages = [];
  const logs = [];
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
