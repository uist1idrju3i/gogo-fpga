import { attachBytePipe, createBytePipe } from "./byte-pipe.mjs";

const MAX_LINE = 8 * 1024 * 1024;

export function createFormalProcessClient(postMessage, jobId) {
  let sequence = 0;
  return Object.freeze({
    spawn_solver(pythonArgs, mergeStderr = true) {
      const args = pythonArgs.toJs();
      if (typeof mergeStderr !== "boolean" || !Array.isArray(args) || args.length < 1 || args.length > 32 ||
          !args.every(arg => typeof arg === "string" && arg.length <= 256 && !arg.includes("\0"))) {
        throw new TypeError("Invalid virtual solver command");
      }
      const channels = { stdin: createBytePipe(), stdout: createBytePipe(), stderr: createBytePipe() };
      const input = attachBytePipe(channels.stdin, "writer");
      const output = attachBytePipe(channels.stdout, "reader");
      const errorOutput = attachBytePipe(channels.stderr, "reader");
      const control = new Int32Array(new SharedArrayBuffer(8));
      const processId = `${jobId}:${++sequence}`;
      let pending = new Uint8Array();
      let stdoutEnded = false;
      let stderrEnded = false;
      let stderrBytes = 0;

      function check() {
        const state = Atomics.load(control, 0);
        if (state === 2) throw new Error("Virtual solver transport failed");
        if (state !== 0 && state !== 1) throw new Error("Invalid virtual solver process state");
        if (state === 1 && (Atomics.load(control, 1) < 0 || Atomics.load(control, 1) > 255)) throw new Error("Invalid virtual solver exit code");
        while (!stderrEnded) {
          const bytes = errorOutput.readAvailable(64 * 1024);
          if (bytes === null) break;
          if (bytes.length === 0) { stderrEnded = true; break; }
          stderrBytes += bytes.length;
          if (stderrBytes > MAX_LINE) throw new Error("Virtual solver stderr limit");
          // SMTIO requests stderr merged into stdout; the broker enforces this.
          throw new Error("Unexpected separate virtual solver stderr");
        }
      }

      function readline(timeoutSeconds = -1) {
        if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds) ||
            timeoutSeconds < -1 || timeoutSeconds > 300) throw new RangeError("Invalid solver read deadline");
        const deadline = timeoutSeconds < 0 ? Infinity : performance.now() + timeoutSeconds * 1000;
        for (;;) {
          check();
          const newline = pending.indexOf(10);
          if (newline >= 0 || stdoutEnded) {
            const size = newline >= 0 ? newline + 1 : pending.length;
            const line = pending.slice(0, size);
            pending = pending.slice(size);
            return line;
          }
          const bytes = output.readAvailable(64 * 1024);
          if (bytes !== null) {
            if (bytes.length === 0) { stdoutEnded = true; continue; }
            if (pending.length + bytes.length > MAX_LINE) throw new Error("Virtual solver line limit");
            const combined = new Uint8Array(pending.length + bytes.length);
            combined.set(pending);
            combined.set(bytes, pending.length);
            pending = combined;
            continue;
          }
          const remaining = deadline - performance.now();
          if (remaining <= 0) return null;
          output.waitReadableSync(Math.min(remaining, 100));
        }
      }

      postMessage({ type: "spawn-solver", jobId, processId, args, mergeStderr, channels, control: control.buffer });
      return Object.freeze({
        stdin_write(bytes) {
          check();
          const data = bytes.toJs();
          if (!(data instanceof Uint8Array)) throw new TypeError("Solver input must be bytes");
          input.writeSync(data);
          return data.length;
        },
        stdin_close() { input.end(); },
        readline,
        poll() {
          check();
          return Atomics.load(control, 0) === 1 ? Atomics.load(control, 1) : null;
        },
        finish(allowFailure = false) {
          if (typeof allowFailure !== "boolean") throw new TypeError("Invalid virtual process wait mode");
          while (readline().length !== 0) { /* Drain the original reader queue before joining. */ }
          for (;;) {
            check();
            const state = Atomics.load(control, 0);
            if (state === 1) {
              const code = Atomics.load(control, 1);
              if (code !== 0 && !allowFailure) throw new Error(`Virtual solver exited with code ${code}`);
              return code;
            }
            Atomics.wait(control, 0, state, 100);
          }
        },
        terminate() {
          input.cancel(); output.cancel(); errorOutput.cancel();
          postMessage({ type: "stop-process", jobId, processId });
        },
      });
    },
  });
}
