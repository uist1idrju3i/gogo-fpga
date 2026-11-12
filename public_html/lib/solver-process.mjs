import { attachBytePipe, createBytePipe } from "./byte-pipe.mjs";

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const FAILURE_STATUSES = new Set(["integrity-error", "invalid-wasm", "runtime-error", "setup-error"]);

export function startSolverProcess({
  wasm,
  sha256,
  args,
  timeoutMs = 30_000,
  capacity = 64 * 1024,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  onStdout = () => {},
  onStderr = () => {},
  workerFactory = () => new Worker(new URL("../solver-worker.mjs", import.meta.url), { type: "module" }),
}) {
  if (!(wasm instanceof Uint8Array) || wasm.length === 0 || wasm.length > 64 * 1024 * 1024 ||
      typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
      !Array.isArray(args) || args.length === 0 || args.length > 32 ||
      !args.every(arg => typeof arg === "string" && arg.length <= 256 && !arg.includes("\0"))) {
    throw new TypeError("Invalid solver binary, digest or arguments");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES ||
      typeof onStdout !== "function" || typeof onStderr !== "function" || typeof workerFactory !== "function") {
    throw new TypeError("Invalid solver process limits or callbacks");
  }
  const channels = { stdin: createBytePipe(capacity), stdout: createBytePipe(capacity), stderr: createBytePipe(capacity) };
  const input = attachBytePipe(channels.stdin, "writer");
  const output = attachBytePipe(channels.stdout, "reader");
  const errorOutput = attachBytePipe(channels.stderr, "reader");
  const binary = new Uint8Array(wasm);
  const jobId = globalThis.crypto.randomUUID();
  const worker = workerFactory();
  if (!worker || !["postMessage", "terminate", "addEventListener", "removeEventListener"].every(key => typeof worker[key] === "function")) {
    worker?.terminate?.();
    throw new TypeError("Invalid solver worker");
  }
  const started = performance.now();
  const counts = { stdout: 0, stderr: 0 };
  const ended = { stdout: false, stderr: false };
  let terminal = false;
  let acknowledgement = null;
  let deadline;
  let resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });

  function finish(status, message = null) {
    if (terminal) return;
    terminal = true;
    clearTimeout(deadline);
    let cleanupError = false;
    for (const endpoint of [input, output, errorOutput]) {
      try { status === "exited" ? endpoint.close() : endpoint.cancel(); }
      catch { cleanupError = true; }
    }
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    worker.removeEventListener("messageerror", onMessageError);
    try { worker.terminate()?.catch?.(() => {}); }
    catch { cleanupError = true; }
    if (cleanupError && status === "exited") status = "transport-error";
    resolveCompletion(Object.freeze({
      jobId, status, sha256,
      integrityVerified: acknowledgement?.sha256 === sha256,
      exitCode: acknowledgement?.result?.exitCode ?? null,
      memoryBytes: acknowledgement?.result?.memoryBytes ?? null,
      stdoutBytes: counts.stdout, stderrBytes: counts.stderr,
      elapsedMs: performance.now() - started,
      error: message,
    }));
  }

  function maybeFinish() {
    if (acknowledgement && ended.stdout && ended.stderr) {
      finish(acknowledgement.status, acknowledgement.error ?? null);
    }
  }

  function onMessage({ data }) {
    if (terminal || data?.jobId !== jobId) return;
    if (acknowledgement) { finish("protocol-error", "Duplicate solver termination"); return; }
    if (data.type === "exit" && data.sha256 === sha256 &&
        Number.isInteger(data.result?.exitCode) && data.result.exitCode >= 0 && data.result.exitCode <= 255 &&
        Number.isInteger(data.result.memoryBytes) && data.result.memoryBytes > 0) {
      if (data.result.memoryBytes > MAX_MEMORY_BYTES) { finish("memory-limit"); return; }
      acknowledgement = { ...data, status: "exited" };
    } else if (data.type === "failure" && FAILURE_STATUSES.has(data.status) && typeof data.error === "string" && data.error.length <= 1024) {
      acknowledgement = data;
    } else { finish("protocol-error", "Invalid solver termination"); return; }
    try { input.close(); }
    catch { finish("transport-error"); return; }
    maybeFinish();
  }

  function onError(event) { event.preventDefault?.(); finish("crashed", String(event.message ?? "Worker crashed").slice(0, 1024)); }
  function onMessageError() { finish("protocol-error", "Worker message could not be decoded"); }

  async function drain(endpoint, name, callback) {
    try {
      while (!terminal) {
        const bytes = await endpoint.readAsync(64 * 1024);
        if (terminal) return;
        if (bytes.length === 0) { ended[name] = true; maybeFinish(); return; }
        if (counts.stdout + counts.stderr + bytes.length > maxOutputBytes) { finish("output-limit"); return; }
        counts[name] += bytes.length;
        await callback(bytes, jobId);
      }
    } catch (error) { if (!terminal) finish("transport-error", String(error.message).slice(0, 1024)); }
  }

  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  worker.addEventListener("messageerror", onMessageError);
  deadline = setTimeout(() => finish("timeout"), timeoutMs);
  void drain(output, "stdout", onStdout);
  void drain(errorOutput, "stderr", onStderr);
  try { worker.postMessage({ jobId, wasm: binary, sha256, args: [...args], channels }, [binary.buffer]); }
  catch (error) { finish("setup-error", String(error.message).slice(0, 1024)); }

  function requireOpen() {
    if (terminal || acknowledgement) throw new Error("Solver process is closed");
  }
  return Object.freeze({
    jobId, completion,
    async write(bytes) { requireOpen(); await input.writeAsync(bytes); },
    endInput() { requireOpen(); input.end(); },
    cancel() { finish("cancelled"); },
  });
}
