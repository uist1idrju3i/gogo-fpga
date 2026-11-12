import { attachBytePipe, createBytePipe } from "./byte-pipe.mjs";
import { applyWorkspaceDelta, packWorkspaceDelta } from "./formal-workspace.mjs";
import { validateFormalToolCommand } from "./formal-tool-command.mjs";

export function startFormalToolProcess({ data, sources, manifest, solvers, yosys, pythonFactory,
  workerFactory, solverWorkerFactory, wasiWorkerFactory = () => new Worker(new URL("../formal-wasi-worker.mjs", import.meta.url), { type: "module" }),
  timeoutMs, onStdout, onStderr }) {
  const command = validateFormalToolCommand(data.args, data.cwd);
  let child;
  let worker;
  let terminal = false;
  let resolve;
  const completion = new Promise(done => { resolve = done; });
  const streams = [];
  function finish(result) {
    if (terminal) return;
    terminal = true;
    try { worker?.terminate()?.catch?.(() => {}); } catch { result = { status: "transport-error" }; }
    for (const stream of streams) { try { stream.cancel(); } catch { /* Already stopped. */ } }
    resolve(result);
  }
  if (command.runtime === "python") {
    child = pythonFactory({ sources, manifest, solvers, files: data.files, cwd: data.cwd,
      entrypoint: command.entrypoint, args: command.args, timeoutMs, workerFactory, solverWorkerFactory,
      onStdout: line => onStdout(new TextEncoder().encode(line)),
      onStderr: line => onStderr(new TextEncoder().encode(line)) });
    void child.completion.then(async result => {
      if (terminal) return;
      if (result.status !== "exited" || result.integrityVerified !== true) { finish(result); return; }
      const frame = await packWorkspaceDelta(data.files, result.files);
      finish({ status: "exited", exitCode: result.exitCode, integrityVerified: true, frame, children: result.children });
    }).catch(error => finish({ status: "transport-error", error: String(error.message).slice(0, 1024) }));
  } else {
    if (!yosys) throw new Error("Missing pinned formal Yosys assets");
    worker = wasiWorkerFactory();
    if (!worker || !["postMessage", "terminate", "addEventListener", "removeEventListener"].every(name => typeof worker[name] === "function")) {
      worker?.terminate?.(); throw new Error("Invalid formal WASI worker");
    }
    const channels = { stdout: createBytePipe(), stderr: createBytePipe() };
    const stdout = attachBytePipe(channels.stdout, "reader");
    const stderr = attachBytePipe(channels.stderr, "reader");
    streams.push(stdout, stderr);
    const forward = async (reader, callback) => {
      for (;;) {
        const bytes = await reader.readAsync(64 * 1024);
        if (!bytes.length) return;
        await callback(bytes);
      }
    };
    const forwarding = Promise.all([forward(stdout, onStdout), forward(stderr, onStderr)]);
    void forwarding.catch(error => { if (!terminal) finish({ status: "transport-error", error: String(error.message).slice(0, 1024) }); });
    worker.addEventListener("message", ({ data: result }) => {
      if (terminal) return;
      void (async () => {
        if (result?.type !== "exit" || result.jobId !== data.processId || result.integrityVerified !== true ||
            result.sha256 !== yosys.sha256 || result.shareSha256 !== yosys.shareSha256 ||
            !Number.isInteger(result.result?.exitCode) || result.result.exitCode < 0 || result.result.exitCode > 255 ||
            !(result.frame instanceof Uint8Array)) throw new Error(result?.error ?? "Invalid formal WASI result");
        await applyWorkspaceDelta(data.files, result.frame);
        await forwarding;
        finish({ status: "exited", exitCode: result.result.exitCode, integrityVerified: true, frame: result.frame });
      })().catch(error => finish({ status: "transport-error", error: String(error.message).slice(0, 1024) }));
    });
    worker.addEventListener("error", event => { event.preventDefault?.(); finish({ status: "crashed", error: String(event.message).slice(0, 1024) }); });
    worker.addEventListener("messageerror", () => finish({ status: "protocol-error" }));
    try { worker.postMessage({ ...yosys, jobId: data.processId, args: data.args, cwd: data.cwd, files: data.files, channels }); }
    catch (error) { finish({ status: "setup-error", error: String(error.message).slice(0, 1024) }); }
  }
  return Object.freeze({ completion, cancel() { child?.cancel(); finish({ status: "cancelled" }); } });
}
