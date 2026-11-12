import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

export function createFormalControlWorkers(mode) {
  const flag = new SharedArrayBuffer(4);
  const workers = [];
  const events = [];
  const started = performance.now();
  let job;
  let injected = false;
  const record = (worker, event, detail = {}) => events.push({ worker: worker.id, kind: worker.kind, event, ms: performance.now() - started, ...detail });
  function factory(kind, url) {
    const worker = new Worker(url, { execArgv: [] });
    const state = { id: workers.length, kind, stopped: false, exited: false, acknowledged: false, root: false, jobId: null };
    const listeners = new Map();
    const emit = (name, event) => { for (const listener of [...(listeners.get(name) ?? [])]) listener(event); };
    state.emit = emit;
    workers.push(state);
    let resolveExit;
    state.completion = new Promise(resolve => { resolveExit = resolve; });
    worker.on("message", data => {
      if (data.type === "test-observation") {
        const { type: _type, jobId, ...detail } = data;
        assert.equal(jobId, state.jobId);
        record(state, detail.event, detail);
        if (data.event === "solver-stdin-wait" && !injected && ["cancel", "crash", "protocol"].includes(mode)) {
          injected = true;
          assert.ok(job && !state.exited);
          const root = workers.find(item => item.root);
          assert.ok(root && !root.exited);
          record(root, "fault-trigger", { mode, activeWorkers: workers.filter(item => !item.exited).map(item => item.id) });
          if (mode === "cancel") job.cancel();
          if (mode === "crash") Atomics.store(new Int32Array(flag), 0, 1);
          if (mode === "protocol") root.emit("message", { data: { type: "exit", jobId: root.jobId, exitCode: 0, integrityVerified: true, files: [] } });
        }
        return;
      }
      if (data.type === "exit" || data.type === "failure") state.acknowledged = true;
      record(state, "message", { type: data.type });
      emit("message", { data });
    });
    worker.on("error", error => { record(state, "error", { message: error.message }); emit("error", { message: error.message }); });
    worker.on("messageerror", error => emit("messageerror", error));
    worker.on("exit", code => {
      state.exited = true;
      record(state, "exit", { code, expectedTermination: state.stopped, acknowledged: state.acknowledged });
      if (!state.stopped && (!state.acknowledged || code !== 0)) emit("error", { message: `Unexpected Node worker exit: ${code}` });
      resolveExit();
    });
    return {
      postMessage(data, ...rest) {
        state.jobId = data.jobId;
        state.root = kind === "python" && data.entrypoint === "sby";
        record(state, "start", { jobId: data.jobId, entrypoint: data.entrypoint ?? null, args: data.args, sha256: data.sha256 ?? null, root: state.root });
        worker.postMessage({ ...data, testControl: { mode, root: state.root, flag } }, ...rest);
      },
      terminate() { state.stopped = true; record(state, "terminate"); return worker.terminate(); },
      addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
      removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
    };
  }
  return {
    events,
    setJob(value) { job = value; },
    workerFactory: () => factory("python", new URL("./formal-controlled-python-worker.mjs", import.meta.url)),
    solverWorkerFactory: () => factory("solver", new URL("./formal-controlled-solver-worker.mjs", import.meta.url)),
    wasiWorkerFactory: () => factory("wasi", new URL("../web/formal-wasi-node-worker.mjs", import.meta.url)),
    async settled() {
      let timer;
      try {
        await Promise.race([Promise.all(workers.map(item => item.completion)), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Controlled worker did not stop")), 5000);
        })]);
      } finally { clearTimeout(timer); }
      assert.ok(workers.length > 0 && workers.every(item => item.exited));
      return workers.map(({ id, kind, root, stopped, exited }) => ({ id, kind, root, stopped, exited }));
    },
  };
}
