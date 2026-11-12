import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createSmtResponseFramer } from "../../web/lib/smt-response-framer.mjs";
import { startSolverProcess } from "../../web/lib/solver-process.mjs";
import { nodeSolverWorker } from "../web/solver-process-helpers.mjs";

export const root = path.resolve(import.meta.dirname, "../..");
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_OUTPUT = 8 * 1024 * 1024;

export function verifyNativeSolver(executable, bin, sha256, env) {
  const resolved = execFileSync("python3", ["-c", "import shutil, sys; print(shutil.which(sys.argv[1]))", executable],
    { env, encoding: "utf8", timeout: 10000 }).trim();
  assert.equal(resolved, path.join(bin, executable), "Native solver resolved outside its isolated bin directory");
  assert.equal(digest(readFileSync(resolved)), sha256, "Resolved native solver hash mismatch");
  return { path: resolved, sha256 };
}

export function loadSolverProbe(directory, solver, runtime) {
  const location = path.resolve(root, directory);
  const metadata = readFileSync(path.join(location, "metadata.json"));
  const info = JSON.parse(metadata);
  assert.equal(info.status, "built");
  assert.equal(info.solver, solver);
  assert.equal(info.runtime, runtime);
  assert.equal(info.worktree_status, "");
  const tree = execFileSync("git", ["ls-tree", "HEAD", `vendor/${solver}`], { cwd: root, encoding: "utf8" });
  assert.equal(info.source.commit, tree.match(/^160000 commit ([a-f0-9]{40})\t/)?.[1]);
  assert.match(info.base_commit, /^[a-f0-9]{40}$/);
  const buildScript = execFileSync("git", ["show", `${info.base_commit}:scripts/build-solver-probe.py`], { cwd: root });
  assert.equal(info.script_sha256, digest(buildScript));
  for (const patch of info.patches) assert.equal(digest(readFileSync(path.join(root, patch.path))), patch.sha256);
  const binaryPath = path.resolve(location, info.artifact.path);
  assert.ok(binaryPath.startsWith(location + path.sep));
  const binary = new Uint8Array(readFileSync(binaryPath));
  assert.equal(binary.length, info.artifact.bytes);
  assert.equal(digest(binary), info.artifact.sha256);
  return { info, binary, binaryPath, buildScript, directory: location, metadata, metadataSha256: digest(metadata) };
}

function collectOutput() {
  const framer = createSmtResponseFramer();
  const stdout = [];
  const stderr = [];
  const frames = [];
  const pending = new Set();
  let requested = 0;
  let ended = false;
  let framingError = null;
  function notify() { for (const check of pending) check(); }
  return {
    stdout(bytes) {
      stdout.push(Buffer.from(bytes));
      try { frames.push(...framer.push(bytes)); }
      catch (error) { framingError = error; notify(); throw error; }
      notify();
    },
    stderr(bytes) { stderr.push(Buffer.from(bytes)); },
    finish() {
      if (ended) return;
      try { frames.push(...framer.end()); }
      catch (error) { framingError ??= error; }
      ended = true;
      notify();
    },
    readResponse() {
      const index = requested++;
      return new Promise((resolve, reject) => {
        function check() {
          if (framingError || frames.length > index || ended) {
            pending.delete(check);
            if (framingError) reject(framingError);
            else if (frames.length > index) resolve(frames[index]);
            else reject(new Error(`Missing solver response ${index + 1}`));
          }
        }
        pending.add(check);
        check();
      });
    },
    snapshot() {
      const out = Buffer.concat(stdout);
      const err = Buffer.concat(stderr);
      return { stdout: out, stderr: err, frames: [...frames], framingError: framingError?.message ?? null,
        stdoutSha256: digest(out), stderrSha256: digest(err), framesSha256: digest(JSON.stringify(frames)) };
    },
  };
}

function startNative(probe, args, output, { timeoutMs, maxOutputBytes, resourceFile }) {
  const started = performance.now();
  const command = resourceFile ? "/usr/bin/time" : probe.binaryPath;
  const argv = resourceFile ? ["-q", "-f", "%M", "-o", resourceFile, probe.binaryPath, ...args] : args;
  const child = spawn(command, argv, { cwd: root, detached: true,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let inputEnded = false;
  let failure = null;
  let errorMessage = null;
  let total = 0;
  function stop(status, message = null) {
    if (closed) return;
    failure ??= status;
    errorMessage ??= message;
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = setTimeout(() => stop("timeout"), timeoutMs);
  child.stdin.on("error", () => {});
  for (const name of ["stdout", "stderr"]) child[name].on("data", bytes => {
    if (failure) return;
    if (total + bytes.length > maxOutputBytes) { stop("output-limit"); return; }
    total += bytes.length;
    try { output[name](bytes); }
    catch (error) { stop("protocol-error", error.message); }
  });
  child.on("error", error => { failure ??= "setup-error"; errorMessage ??= error.message; });
  const completion = new Promise(resolve => child.on("close", (exitCode, signal) => {
    closed = true;
    clearTimeout(deadline);
    let nativeMaxRssKiB = null;
    if (resourceFile && existsSync(resourceFile)) {
      const text = readFileSync(resourceFile, "utf8").trim();
      if (/^[0-9]+$/.test(text)) nativeMaxRssKiB = Number(text);
    }
    resolve({ status: failure ?? (signal ? "crashed" : "exited"), exitCode, signal,
      elapsedMs: performance.now() - started, nativeMaxRssKiB, memoryBytes: null, error: errorMessage });
  }));
  return {
    completion,
    write(bytes) {
      if (closed || inputEnded) return Promise.reject(new Error("Solver process is closed"));
      return new Promise((resolve, reject) => child.stdin.write(bytes, error => error ? reject(error) : resolve()));
    },
    endInput() { if (closed || inputEnded) throw new Error("Solver process is closed"); inputEnded = true; child.stdin.end(); },
    cancel() { stop("cancelled"); },
  };
}

export function startProbeSession(probe, {
  timeoutMs = 30000, capacity = 7, chunkBytes = 3, maxOutputBytes = MAX_OUTPUT,
  resourceFile, mode = "normal", wasm = probe.binary, sha256 = probe.info.artifact.sha256,
  args = probe.info.solver === "yices2" ? ["--incremental"] : ["-in", "-smt2"],
  stdoutDelayMs = 0,
} = {}) {
  const output = collectOutput();
  let delayed = false;
  const handle = probe.info.runtime === "native" ? startNative(probe, args, output, { timeoutMs, maxOutputBytes, resourceFile }) : startSolverProcess({
    wasm, sha256, args: [probe.info.solver, ...args], timeoutMs, capacity, maxOutputBytes,
    onStdout: async bytes => {
      if (!delayed && stdoutDelayMs) {
        delayed = true;
        await new Promise(resolve => setTimeout(resolve, stdoutDelayMs));
      }
      output.stdout(bytes);
    },
    onStderr: bytes => output.stderr(bytes), workerFactory: () => nodeSolverWorker(mode),
  });
  const completion = handle.completion.then(result => {
    output.finish();
    return { ...result, ...output.snapshot() };
  });
  return {
    completion, readResponse: () => output.readResponse(),
    async send(source) {
      const bytes = new TextEncoder().encode(source + "\n");
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) await handle.write(bytes.subarray(offset, offset + chunkBytes));
    },
    write: bytes => handle.write(bytes), endInput: () => handle.endInput(), cancel: () => handle.cancel(),
  };
}
