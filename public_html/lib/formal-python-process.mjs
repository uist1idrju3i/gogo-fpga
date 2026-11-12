import { attachBytePipe } from "./byte-pipe.mjs";
import { startSolverProcess } from "./solver-process.mjs";
import { safePath } from "./verified-assets.mjs";
import { startFormalToolProcess } from "./formal-tool-process.mjs";

const FAILURE_STATUSES = new Set(["setup-error", "integrity-error", "runtime-error"]);

export function startFormalPython({ sources, manifest, entrypoint, args, files, solvers, yosys, cwd = null,
  timeoutMs = 30_000, onStdout = () => {}, onStderr = () => {},
  workerFactory = () => new Worker(new URL("../formal-python-worker.mjs", import.meta.url), { type: "module" }),
  solverWorkerFactory,
  wasiWorkerFactory,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new RangeError("Invalid formal deadline");
  if (typeof onStdout !== "function" || typeof onStderr !== "function") throw new TypeError("Invalid formal callbacks");
  const worker = workerFactory();
  if (!worker || !["postMessage", "terminate", "addEventListener", "removeEventListener"].every(name => typeof worker[name] === "function")) {
    worker?.terminate?.();
    throw new TypeError("Invalid formal worker");
  }
  const jobId = crypto.randomUUID();
  const active = new Map();
  const identities = new Set();
  const results = [];
  const started = performance.now();
  let terminal = false;
  let rootExiting = false;
  let outputBytes = 0;
  let resolve;
  const completion = new Promise(done => { resolve = done; });
  let deadline = setTimeout(checkDeadline, timeoutMs);

  function checkDeadline() {
    if (terminal) return;
    const remaining = timeoutMs - (performance.now() - started);
    if (remaining > 0) {
      deadline = setTimeout(checkDeadline, Math.ceil(remaining));
      return;
    }
    finish("timeout");
  }

  function finish(status, payload = {}) {
    if (terminal) return;
    terminal = true;
    clearTimeout(deadline);
    const stopping = [];
    for (const child of active.values()) {
      try { child.abort(); } catch { status = "transport-error"; }
      if (child.completion) stopping.push(child.completion);
    }
    worker.removeEventListener("message", message);
    worker.removeEventListener("error", error);
    worker.removeEventListener("messageerror", decodingError);
    try { worker.terminate()?.catch?.(() => {}); } catch { status = "transport-error"; }
    void Promise.allSettled(stopping).then(() => {
      resolve({ ...payload, status, jobId, children: [...results], elapsedMs: performance.now() - started });
    });
  }

  function log(type, text) {
    if (typeof text !== "string") throw new Error("Invalid formal log");
    outputBytes += new TextEncoder().encode(text).length;
    if (outputBytes > 8 * 1024 * 1024) { finish("output-limit"); return; }
    (type === "stdout" ? onStdout : onStderr)(text);
  }

  function spawn(data) {
    if (identities.has(data.processId) || typeof data.processId !== "string" ||
        !data.processId.startsWith(jobId + ":") || identities.size >= 256) throw new Error("Invalid virtual process identity");
    identities.add(data.processId);
    if (!(data.control instanceof SharedArrayBuffer) || data.control.growable || data.control.byteLength !== 8) throw new Error("Invalid process control");
    const control = new Int32Array(data.control);
    if (Atomics.load(control, 0) !== 0 || Atomics.load(control, 1) !== 0) throw new Error("Invalid initial process control");
    const input = attachBytePipe(data.channels.stdin, "reader");
    const output = attachBytePipe(data.channels.stdout, "writer");
    const stderr = attachBytePipe(data.channels.stderr, "writer");
    let process;
    let writes = Promise.resolve();
    const mergedOutput = bytes => {
      writes = writes.then(() => output.writeAsync(bytes));
      return writes;
    };
    const child = { abort() {
      Atomics.store(control, 0, 2); Atomics.notify(control, 0);
      for (const endpoint of [input, output, stderr]) endpoint.cancel();
      process?.cancel();
    } };
    active.set(data.processId, child);
    try {
      if (!Array.isArray(data.args) || !Object.hasOwn(solvers, data.args[0])) throw new Error("Unsupported virtual solver");
      const mergeStderr = data.mergeStderr === undefined ? true : data.mergeStderr;
      if (typeof mergeStderr !== "boolean") throw new Error("Invalid virtual solver stderr mode");
      const configuredCodes = solvers[data.args[0]].exitCodes;
      if (configuredCodes !== undefined && !Array.isArray(configuredCodes)) throw new Error("Invalid solver exit code policy");
      const exitCodes = [...(configuredCodes ?? [0])];
      if (!exitCodes.length || exitCodes.length > 16 || new Set(exitCodes).size !== exitCodes.length ||
          !exitCodes.every(code => Number.isInteger(code) && code >= 0 && code <= 255)) throw new Error("Invalid solver exit code policy");
      const decoder = new TextDecoder();
      process = startSolverProcess({ ...solvers[data.args[0]], args: data.args,
        timeoutMs: Math.max(1, Math.ceil(timeoutMs - (performance.now() - started))),
        workerFactory: solverWorkerFactory,
        onStdout: mergedOutput,
        onStderr: mergeStderr ? mergedOutput : bytes => log("stderr", decoder.decode(bytes, { stream: true })),
      });
      void (async () => {
        try {
          for (;;) {
            const bytes = await input.readAsync(64 * 1024);
            if (bytes.length === 0) { process.endInput(); return; }
            await process.write(bytes);
          }
        } catch (error) { if (active.has(data.processId)) process.cancel(); }
      })();
      child.completion = process.completion.then(result => {
        if (!mergeStderr && !terminal) log("stderr", decoder.decode());
        results.push({ processId: data.processId, args: data.args, ...result, exitCodes });
        if (terminal) return;
        if (result.status !== "exited" || !result.integrityVerified) child.abort();
        else {
          output.end(); stderr.end();
          Atomics.store(control, 1, result.exitCode);
          Atomics.store(control, 0, 1); Atomics.notify(control, 0);
        }
      }).catch(() => finish("transport-error")).finally(() => active.delete(data.processId));
    } catch (error) { child.abort(); throw error; }
  }

  function spawnTool(data) {
    if (entrypoint !== "sby" || identities.has(data.processId) || typeof data.processId !== "string" ||
        !data.processId.startsWith(jobId + ":") || identities.size >= 256) throw new Error("Invalid SBY process identity");
    identities.add(data.processId);
    if (!(data.control instanceof SharedArrayBuffer) || data.control.growable || data.control.byteLength !== 8) throw new Error("Invalid SBY process control");
    const control = new Int32Array(data.control);
    if (Atomics.load(control, 0) !== 0 || Atomics.load(control, 1) !== 0) throw new Error("Invalid initial SBY process control");
    const output = attachBytePipe(data.channels.stdout, "writer");
    const stderr = attachBytePipe(data.channels.stderr, "writer");
    const delta = attachBytePipe(data.channels.delta, "writer");
    let process;
    let writes = Promise.resolve();
    let bytesWritten = 0;
    const mergedOutput = bytes => {
      bytesWritten += bytes.length;
      if (bytesWritten > 8 * 1024 * 1024) throw new Error("SBY child output limit");
      writes = writes.then(() => output.writeAsync(bytes));
      void writes.catch(() => {});
      return writes;
    };
    const child = { expectedTermination: false, abort() {
      Atomics.store(control, 0, 2); Atomics.notify(control, 0);
      for (const endpoint of [output, stderr, delta]) endpoint.cancel();
      process?.cancel();
    } };
    active.set(data.processId, child);
    try {
      process = startFormalToolProcess({ data, sources, manifest, solvers, yosys,
        pythonFactory: startFormalPython, workerFactory, solverWorkerFactory, wasiWorkerFactory,
        timeoutMs: Math.max(1, Math.ceil(timeoutMs - (performance.now() - started))),
        onStdout: mergedOutput, onStderr: mergedOutput });
      child.completion = process.completion.then(async result => {
        const { frame, files: unusedFiles, ...metadata } = result;
        results.push({ processId: data.processId, args: data.args, role: "tool", expectedTermination: child.expectedTermination, ...metadata });
        if (terminal || child.expectedTermination) return;
        if (result.status !== "exited" || result.integrityVerified !== true ||
            !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 || !(frame instanceof Uint8Array)) {
          child.abort(); return;
        }
        await writes;
        for (let offset = 0; offset < frame.length; offset += 1024 * 1024) await delta.writeAsync(frame.subarray(offset, offset + 1024 * 1024));
        output.end(); stderr.end(); delta.end();
        Atomics.store(control, 1, result.exitCode);
        Atomics.store(control, 0, 1); Atomics.notify(control, 0);
      }).catch(error => {
        if (!terminal && !child.expectedTermination) finish("transport-error", { error: String(error.message).slice(0, 1024) });
      }).finally(() => active.delete(data.processId));
    } catch (error) { child.abort(); throw error; }
  }

  function message({ data }) {
    if (terminal || rootExiting || data?.jobId !== jobId) return;
    try {
      if (data.type === "spawn-solver") spawn(data);
      else if (data.type === "spawn-process") spawnTool(data);
      else if (data.type === "stop-process") {
        const child = active.get(data.processId);
        if (child) { child.expectedTermination = true; child.abort(); }
      }
      else if (data.type === "stdout" || data.type === "stderr") {
        log(data.type, data.text);
      } else if (data.type === "exit" && Number.isInteger(data.exitCode) && data.exitCode >= 0 && data.exitCode <= 255 && data.integrityVerified === true) {
        if (!Array.isArray(data.files) || data.files.length > 4096) throw new Error("Invalid formal result files");
        const paths = new Set();
        let bytes = 0;
        for (const file of data.files) {
          if (!safePath(file?.path) || file.path.includes("\0") || paths.has(file.path) || !(file.bytes instanceof Uint8Array)) throw new Error("Invalid formal result file");
          paths.add(file.path); bytes += file.bytes.length;
          if (bytes > 32 * 1024 * 1024) throw new Error("Formal result file limit");
        }
        const pending = [...active.values()];
        if (pending.some(child => !child.expectedTermination)) throw new Error("Formal subprocess is still active at root exit");
        rootExiting = true;
        void Promise.allSettled(pending.map(child => child.completion)).then(() => {
          if (results.some(result => !result.expectedTermination && (result.status !== "exited" || !result.integrityVerified ||
              (result.role !== "tool" && !result.exitCodes.includes(result.exitCode))))) {
            finish("transport-error", { error: "Formal subprocess did not terminate cleanly", exitCode: data.exitCode });
          } else finish("exited", data);
        });
      } else if (data.type === "failure" && FAILURE_STATUSES.has(data.status) && typeof data.error === "string" && data.error.length <= 1024) finish(data.status, { error: data.error });
      else throw new Error("Invalid formal worker message");
    } catch (error) { finish("protocol-error", { error: String(error.message).slice(0, 1024) }); }
  }
  function error(event) { event.preventDefault?.(); finish("crashed", { error: String(event.message).slice(0, 1024) }); }
  function decodingError() { finish("protocol-error"); }
  worker.addEventListener("message", message);
  worker.addEventListener("error", error);
  worker.addEventListener("messageerror", decodingError);
  try { worker.postMessage({ jobId, sources, manifest, entrypoint, args, files, cwd }); }
  catch (error) { finish("setup-error", { error: String(error.message).slice(0, 1024) }); }
  return Object.freeze({ jobId, completion, cancel() { finish("cancelled"); } });
}
