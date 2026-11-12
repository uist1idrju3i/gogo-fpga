import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WASI } from "node:wasi";

export const root = path.resolve(import.meta.dirname, "../..");
const wasiBuildRoot = path.resolve(root, process.env.S5_WASI_ROOT ?? "build/wasi");
const nativeBuildRoot = path.resolve(root, process.env.S5_NATIVE_ROOT ?? "build/native");
export const yosysWasmPath = path.join(wasiBuildRoot, "yosys/yosys.wasm");
export const yosysSharePath = path.join(wasiBuildRoot, "yosys/share");
export const nextpnrWasmPath = path.join(wasiBuildRoot, "nextpnr/nextpnr-himbaechel-gowin.wasm");
export const nextpnrNativePath = path.join(nativeBuildRoot, "nextpnr/nextpnr-himbaechel-gowin");
export const wasiSharePath = path.join(wasiBuildRoot, "nextpnr/share");
export const nativeSharePath = path.join(nativeBuildRoot, "nextpnr/share");
export const chipdbPath = path.join(wasiSharePath, "himbaechel/gowin");
export const nativeChipdbPath = path.join(nativeSharePath, "himbaechel/gowin");
export const wasmModule = new WebAssembly.Module(readFileSync(nextpnrWasmPath));
export const yosysModule = new WebAssembly.Module(readFileSync(yosysWasmPath));
const seed = "73421";

assert.ok(existsSync(yosysWasmPath), `WASI Yosys is missing: ${yosysWasmPath}`);
assert.ok(existsSync(nextpnrNativePath), `Native nextpnr is missing: ${nextpnrNativePath}`);
assert.ok(existsSync(wasiSharePath), `WASI chipdb root is missing: ${wasiSharePath}`);
assert.ok(existsSync(nativeSharePath), `Native chipdb root is missing: ${nativeSharePath}`);

export function createWorkdir(prefix = "nextpnr-test-") {
  const workdir = mkdtempSync(path.join(os.tmpdir(), prefix));
  mkdirSync(path.join(workdir, "src"));
  mkdirSync(path.join(workdir, "constraints"));
  mkdirSync(path.join(workdir, "tmp"));
  return workdir;
}

function closeDescriptor(descriptor) {
  try {
    closeSync(descriptor);
  } catch (error) {
    if (error.code !== "EBADF") {
      throw error;
    }
  }
}

export function runWasi(workdir, args, sharePath = wasiSharePath, executable = wasmModule, clockTimeGet = null) {
  const stdoutPath = path.join(workdir, "wasi.stdout");
  const stderrPath = path.join(workdir, "wasi.stderr");
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(stderrPath, "w");
  const wasi = new WASI({
    version: "preview1",
    args: ["nextpnr-himbaechel-gowin", ...args],
    env: { TMPDIR: "/tmp" },
    preopens: {
      "/": workdir,
      "/share": sharePath,
      "/tmp": path.join(workdir, "tmp"),
    },
    stdout,
    stderr,
    returnOnExit: true,
  });
  const started = performance.now();
  let status = 1;
  let error;
  let instance;
  try {
    const importObject = wasi.getImportObject();
    if (clockTimeGet) {
      importObject.wasi_snapshot_preview1.clock_time_get = (clockId, precision, timePointer) =>
        clockTimeGet(instance.exports.memory, clockId, precision, timePointer);
    }
    instance = new WebAssembly.Instance(executable, importObject);
    status = wasi.start(instance);
  } catch (caught) {
    error = caught;
  } finally {
    closeDescriptor(stdout);
    closeDescriptor(stderr);
  }
  return {
    status: Number.isInteger(status) ? status : 0,
    stdout: readFileSync(stdoutPath, "utf8"),
    stderr: readFileSync(stderrPath, "utf8"),
    elapsed: performance.now() - started,
    memoryBytes: instance?.exports.memory instanceof WebAssembly.Memory ? instance.exports.memory.buffer.byteLength : null,
    error,
  };
}

export function runNative(workdir, args) {
  const started = performance.now();
  const result = spawnSync(nextpnrNativePath, args, {
    cwd: workdir,
    encoding: "utf8",
    env: { ...process.env, TMPDIR: path.join(workdir, "tmp") },
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    elapsed: performance.now() - started,
    error: result.error,
    signal: result.signal,
  };
}

export function runYosysWasi(workdir, source, command = "read_verilog src/top.v; synth_gowin -top top -json top.json") {
  writeFileSync(path.join(workdir, "src/top.v"), source);
  const stdout = openSync(path.join(workdir, "yosys.stdout"), "w");
  const stderr = openSync(path.join(workdir, "yosys.stderr"), "w");
  const wasi = new WASI({
    version: "preview1",
    args: ["yosys", "-q", "-p", command],
    env: { TMPDIR: "/tmp" },
    preopens: {
      "/": workdir,
      "/share": yosysSharePath,
      "/tmp": path.join(workdir, "tmp"),
    },
    stdout,
    stderr,
    returnOnExit: true,
  });
  let status = 1;
  let error;
  let instance;
  try {
    instance = new WebAssembly.Instance(yosysModule, wasi.getImportObject());
    status = wasi.start(instance);
  } catch (caught) {
    error = caught;
  } finally {
    closeDescriptor(stdout);
    closeDescriptor(stderr);
  }
  const stderrText = readFileSync(path.join(workdir, "yosys.stderr"), "utf8");
  assert.equal(status, 0, `WASI Yosys synthesis failed:\n${stderrText}\n${error ?? ""}`);
  assert.ok(statSync(path.join(workdir, "top.json")).size > 0, "Yosys produced no JSON");
  return { memoryBytes: instance.exports.memory.buffer.byteLength };
}

export function pnrArgs(board, cstPath = "constraints/board.cst") {
  return [
    "--seed",
    seed,
    "--device",
    board.nextpnrDevice,
    "--vopt",
    `family=${board.nextpnrFamily}`,
    "--vopt",
    `cst=${cstPath}`,
    "--json",
    "top.json",
    "--write",
    "pnr.json",
  ];
}
