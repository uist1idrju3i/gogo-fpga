import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { runSolverJob } from "../../web/lib/solver-job.mjs";

globalThis.crossOriginIsolated = true;
parentPort.once("message", async data => {
  const mode = data.testControl.mode;
  const observe = (event, detail) => parentPort.postMessage({ type: "test-observation", jobId: data.jobId, event, sha256: data.sha256, ...detail });
  const active = !data.args.includes("--help");
  let corrupted = false;
  let captured = "";
  if (mode === "syntax-error" && active) {
    const OriginalInstance = WebAssembly.Instance;
    WebAssembly.Instance = class extends OriginalInstance {
      constructor(module, imports) {
        let instance;
        const original = imports.wasi_snapshot_preview1;
        const wrapped = { ...original,
          fd_read(fd, iovs, count, used) {
            const code = original.fd_read(fd, iovs, count, used);
            if (fd === 0 && code === 0 && !corrupted) {
              const view = new DataView(instance.exports.memory.buffer);
              const length = view.getUint32(used, true);
              if (length && count && view.getUint32(iovs + 4, true)) {
                const pointer = view.getUint32(iovs, true);
                const bytes = new Uint8Array(instance.exports.memory.buffer, pointer, Math.min(length, view.getUint32(iovs + 4, true)));
                const digest = value => createHash("sha256").update(value).digest("hex");
                const beforeSha256 = digest(bytes);
                const before = Buffer.from(bytes).toString("base64");
                bytes[0] = 63;
                corrupted = true;
                observe("solver-syntax-input", { fd, bytes: bytes.length, before, after: Buffer.from(bytes).toString("base64"), beforeSha256, afterSha256: digest(bytes), firstByte: bytes[0] });
              }
            }
            return code;
          },
          fd_write(fd, iovs, count, used) {
            if ([1, 2].includes(fd)) {
              const view = new DataView(instance.exports.memory.buffer);
              for (let n = 0; n < count && captured.length < 8192; n++) {
                const pointer = view.getUint32(iovs + n * 8, true);
                const length = Math.min(view.getUint32(iovs + n * 8 + 4, true), 8192 - captured.length);
                captured += new TextDecoder().decode(new Uint8Array(instance.exports.memory.buffer, pointer, length));
              }
            }
            return original.fd_write(fd, iovs, count, used);
          },
        };
        super(module, { ...imports, wasi_snapshot_preview1: wrapped });
        instance = this;
      }
    };
  }
  const wait = Atomics.wait.bind(Atomics);
  let observed = false;
  Atomics.wait = (...args) => {
    if (!observed && args[0]?.buffer === data.channels.stdin.buffer && args[1] === 3) {
      observed = true;
      parentPort.postMessage({ type: "test-observation", jobId: data.jobId, event: "solver-stdin-wait", channel: "stdin", index: args[1], sha256: data.sha256 });
      if (["cancel", "timeout", "crash", "protocol"].includes(data.testControl.mode)) {
        wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
    }
    return wait(...args);
  };
  const message = await runSolverJob(data);
  if (mode === "syntax-error" && active) observe("solver-syntax-exit", { resultType: message.type, exitCode: message.result?.exitCode ?? null, corrupted, output: captured });
  if (mode === "exit-code" && active && message.type === "exit") {
    observe("solver-exit-code", { originalCode: message.result.exitCode, forcedCode: 9, resultType: message.type });
    message.result.exitCode = 9;
  }
  parentPort.postMessage(message);
});
