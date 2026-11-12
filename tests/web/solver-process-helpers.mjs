import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

export function nodeSolverWorker(mode = "normal") {
  const worker = new Worker(new URL("./solver-node-worker.mjs", import.meta.url), { workerData: { mode }, execArgv: [] });
  const listeners = new Map();
  worker.on("error", () => {});
  return {
    postMessage: (...args) => worker.postMessage(...args),
    terminate: () => worker.terminate(),
    addEventListener(name, listener) {
      const wrapper = name === "message" ? data => listener({ data }) : error => listener({ message: error.message });
      listeners.set(listener, wrapper);
      worker.on(name, wrapper);
    },
    removeEventListener(name, listener) {
      const wrapper = listeners.get(listener);
      if (wrapper) worker.off(name, wrapper);
      listeners.delete(listener);
    },
  };
}

export function commandWasm(instructions = []) {
  const encodeName = name => [name.length, ...new TextEncoder().encode(name)];
  const section = (id, bytes) => [id, bytes.length, ...bytes];
  const body = [0, ...instructions, 11];
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 96, 0, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 1, 1, 1]),
    ...section(7, [2, ...encodeName("memory"), 2, 0, ...encodeName("_start"), 0, 0]),
    ...section(10, [1, body.length, ...body]),
  ]);
}

export function stdioWasm({ stdoutLength = 64, stderrLength = 17, repeat = 1, exitCode = 0, trap = false } = {}) {
  function u32(value) {
    const bytes = [];
    do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
    return bytes;
  }
  function constant(value) {
    const bytes = u32(value);
    if (bytes.at(-1) & 64) bytes.push(0);
    return [65, ...bytes];
  }
  const name = value => [value.length, ...new TextEncoder().encode(value)];
  const section = (id, bytes) => [id, ...u32(bytes.length), ...bytes];
  const fdWrite = (fd, offset) => [...constant(fd), ...constant(offset), ...constant(1), ...constant(8), 16, 0, 26];
  const data = new Uint8Array(32 + stdoutLength + stderrLength);
  const view = new DataView(data.buffer);
  view.setUint32(0, 32, true);
  view.setUint32(4, stdoutLength, true);
  view.setUint32(16, 32 + stdoutLength, true);
  view.setUint32(20, stderrLength, true);
  data.fill(79, 32, 32 + stdoutLength);
  data.fill(69, 32 + stdoutLength);
  const body = [
    1, 1, 127,
    3, 64, ...fdWrite(1, 0),
    32, 0, ...constant(1), 106, 34, 0, ...constant(repeat), 73, 13, 0, 11,
    ...fdWrite(2, 16),
    ...(trap ? [0] : [...constant(exitCode), 16, 1]), 11,
  ];
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [3, 96, 4, 127, 127, 127, 127, 1, 127, 96, 1, 127, 0, 96, 0, 0]),
    ...section(2, [2, ...name("wasi_snapshot_preview1"), ...name("fd_write"), 0, 0,
      ...name("wasi_snapshot_preview1"), ...name("proc_exit"), 0, 1]),
    ...section(3, [1, 2]),
    ...section(5, [1, 1, 1, 1]),
    ...section(7, [2, ...name("memory"), 2, 0, ...name("_start"), 0, 2]),
    ...section(10, [1, ...u32(body.length), ...body]),
    ...section(11, [1, 0, 65, 0, 11, ...u32(data.length), ...data]),
  ]);
}
