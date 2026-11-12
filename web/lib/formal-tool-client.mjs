import { attachBytePipe, createBytePipe } from "./byte-pipe.mjs";
import { safePath } from "./verified-assets.mjs";

export function snapshotWorkspace(FS) {
  const files = [];
  let total = 0;
  function collect(directory, prefix = "") {
    for (const name of FS.readdir(directory).filter(name => name !== "." && name !== "..").sort()) {
      const path = prefix + name;
      if (!safePath(path) || path.includes("\0") || path.length > 512) throw new Error("Invalid workspace path");
      const absolute = `${directory}/${name}`;
      const { mode } = FS.lstat(absolute);
      if (FS.isDir(mode)) collect(absolute, path + "/");
      else if (FS.isFile(mode)) {
        const bytes = FS.readFile(absolute);
        total += bytes.length;
        if (total > 32 * 1024 * 1024 || files.length >= 4096) throw new Error("Workspace snapshot size limit");
        files.push({ path, bytes });
      } else throw new Error("Unsupported workspace file type");
    }
  }
  collect("/work");
  return files;
}

export function createFormalToolClient(postMessage, jobId, FS) {
  let sequence = 0;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  return Object.freeze({
    pause(milliseconds) {
      if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 1000) throw new Error("Invalid virtual process pause");
      Atomics.wait(sleeper, 0, 0, milliseconds);
    },
    spawn_process(pythonArgs, cwd) {
      const args = pythonArgs.toJs();
      if (!Array.isArray(args) || args.length < 1 || args.length > 64 ||
          !args.every(arg => typeof arg === "string" && arg.length < 4096 && !arg.includes("\0")) ||
          !safePath(cwd) || cwd.includes("\0") || cwd.length > 512) throw new Error("Invalid SBY subprocess request");
      const files = snapshotWorkspace(FS);
      const channels = { stdout: createBytePipe(), stderr: createBytePipe(), delta: createBytePipe() };
      const output = attachBytePipe(channels.stdout, "reader");
      const errors = attachBytePipe(channels.stderr, "reader");
      const delta = attachBytePipe(channels.delta, "reader");
      const control = new Int32Array(new SharedArrayBuffer(8));
      const processId = `${jobId}:tool:${++sequence}`;
      let pending = new Uint8Array();
      let outputEnded = false;
      let errorsEnded = false;
      let deltaEnded = false;
      let outputBytes = 0;
      let deltaBytes = 0;
      const chunks = [];
      let taken = false;

      function state() {
        const value = Atomics.load(control, 0);
        const code = Atomics.load(control, 1);
        if (value === 2) throw new Error("Virtual SBY process transport failed");
        if ((value !== 0 && value !== 1) || (value === 1 && (code < 0 || code > 255))) {
          throw new Error("Invalid virtual SBY process control");
        }
        return value;
      }

      function drain() {
        state();
        while (!deltaEnded) {
          const bytes = delta.readAvailable(64 * 1024);
          if (bytes === null) break;
          if (!bytes.length) { deltaEnded = true; break; }
          deltaBytes += bytes.length;
          if (deltaBytes > 4 + 33 * 1024 * 1024) throw new Error("Virtual SBY delta size limit");
          chunks.push(bytes);
        }
        while (!outputEnded) {
          const bytes = output.readAvailable(64 * 1024);
          if (bytes === null) break;
          if (!bytes.length) { outputEnded = true; break; }
          outputBytes += bytes.length;
          if (outputBytes > 8 * 1024 * 1024) throw new Error("Virtual SBY output limit");
          const combined = new Uint8Array(pending.length + bytes.length);
          combined.set(pending); combined.set(bytes, pending.length); pending = combined;
        }
        while (!errorsEnded) {
          const bytes = errors.readAvailable(64 * 1024);
          if (bytes === null) break;
          if (!bytes.length) { errorsEnded = true; break; }
          throw new Error("Unexpected separate SBY stderr");
        }
      }

      postMessage({ type: "spawn-process", jobId, processId, args, cwd, files, channels, control: control.buffer });
      return Object.freeze({
        readline() {
          drain();
          const newline = pending.indexOf(10);
          const size = newline >= 0 ? newline + 1 : outputEnded ? pending.length : 0;
          const line = pending.slice(0, size);
          pending = pending.slice(size);
          return line;
        },
        ready() { drain(); return pending.includes(10) || (outputEnded && pending.length > 0) || state() === 1; },
        poll() {
          drain();
          if (state() !== 1) return undefined;
          drain();
          if (!outputEnded || !errorsEnded || !deltaEnded) throw new Error("Incomplete virtual SBY process output");
          return Atomics.load(control, 1);
        },
        take_delta() {
          if (taken || state() !== 1 || !deltaEnded) throw new Error("Invalid virtual SBY delta request");
          taken = true;
          const frame = new Uint8Array(deltaBytes);
          let offset = 0;
          for (const bytes of chunks) { frame.set(bytes, offset); offset += bytes.length; }
          chunks.length = 0;
          return frame;
        },
        terminate() {
          for (const endpoint of [output, errors, delta]) endpoint.cancel();
          postMessage({ type: "stop-process", jobId, processId });
        },
      });
    },
  });
}
