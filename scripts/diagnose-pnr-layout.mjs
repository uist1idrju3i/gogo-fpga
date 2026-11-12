#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { BOARDS } from "../web/lib/boards.mjs";
import { executionErrorDetails, isCapacityExceeded, parseDeviceUtilization } from "../tests/synth/library-measurements.mjs";
import { nativeSharePath, nextpnrNativePath as nativePath, nextpnrWasmPath as wasmPath, pnrArgs, runNative, runWasi, wasiSharePath } from "../tests/synth/nextpnr-helpers.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  "case-dir": { type: "string" }, out: { type: "string" }, board: { type: "string" },
  repeats: { type: "string", default: "5" }, "native-binary": { type: "string" }, "wasm-binary": { type: "string" },
  "native-share": { type: "string" }, "wasi-share": { type: "string" },
  router: { type: "string" },
  "expect-capacity": { type: "boolean", default: false },
} });
const board = BOARDS.find((board) => board.id === values.board);
assert.ok(board && values["case-dir"] && values.out, "Required: --board BOARD --case-dir DIR --out NEW_DIR");
const repeats = Number(values.repeats);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 5, "At least five repeats are required");
assert.ok(!values.router || ["router1", "router2"].includes(values.router), "Unsupported router");
const args = [...pnrArgs(board), ...(values.router ? ["--router", values.router, "--threads", "1"] : [])];
const source = path.resolve(root, values["case-dir"]);
const out = path.resolve(root, values.out);
const executable = values["native-binary"] ? path.resolve(root, values["native-binary"]) : nativePath;
const wasmExecutable = values["wasm-binary"] ? path.resolve(root, values["wasm-binary"]) : wasmPath;
const nativeShare = values["native-share"] ? path.resolve(root, values["native-share"]) : nativeSharePath;
const wasiShare = values["wasi-share"] ? path.resolve(root, values["wasi-share"]) : wasiSharePath;
const nativeArgs = values["native-share"]
  ? [...args, "--chipdb", path.join(nativeShare, `himbaechel/gowin/chipdb-${board.nextpnrFamily}.bin`)] : args;
const wasm = new WebAssembly.Module(readFileSync(wasmExecutable));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = readFileSync(path.join(source, "top.json"));
const cst = readFileSync(path.join(source, "constraints/board.cst"));
mkdirSync(out);
const version = spawnSync(executable, ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.stderr);
const versionDirectory = path.join(out, "version-probe");
mkdirSync(versionDirectory);
mkdirSync(path.join(versionDirectory, "tmp"));
const wasiVersion = runWasi(versionDirectory, ["--version"], wasiShare, wasm);
assert.equal(wasiVersion.status, 0, `${wasiVersion.stderr}\n${wasiVersion.error ?? ""}`);
const chipdbName = `himbaechel/gowin/chipdb-${board.nextpnrFamily}.bin`;
const nativeChipdb = readFileSync(path.join(nativeShare, chipdbName));
const wasiChipdb = readFileSync(path.join(wasiShare, chipdbName));
assert.deepEqual(nativeChipdb, wasiChipdb, "Native/WASI chipdb inputs differ");
const buildInfoHash = (binary) => {
  const file = path.join(path.dirname(binary), "build-info.json");
  return existsSync(file) ? hash(readFileSync(file)) : null;
};
const metadata = {
  purpose: "Compare repeated layouts and record execution-only timings; no browser or hardware claim",
  measurement_scope: "Native process spawn plus execution; WASI instantiation plus execution, excluding module compilation. WASI memory is final exported linear memory, not host RSS. Native RSS is not measured.",
  criteria: values["expect-capacity"]
    ? "Both backends must reject numeric overflow with matching placement-exhaustion diagnostics, not traps or signals; utilization must agree across all repeats. No routed-layout or performance success claim."
    : "All executions must succeed; each backend must be self-reproducible; utilization must agree. Cross-backend identity is recorded, not assumed.",
  expected_result: values["expect-capacity"] ? "capacity-exceeded" : "routed",
  board: board.id, repeats, args, native_args: nativeArgs,
  shares: { native: path.relative(root, nativeShare), wasi: path.relative(root, wasiShare) },
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  submodules: execFileSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" }),
  working_tree: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }),
  diff_sha256: hash(execFileSync("git", ["diff", "HEAD"], { cwd: root })),
  os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memory_bytes: os.totalmem(), node: process.version,
  nextpnr_version: `${version.stdout}${version.stderr}`.trim(),
  wasi_nextpnr_version: `${wasiVersion.stdout}${wasiVersion.stderr}`.trim(),
  binary_bytes: { native: statSync(executable).size, wasi: statSync(wasmExecutable).size },
  native_binary: path.relative(root, executable),
  wasm_binary: path.relative(root, wasmExecutable),
  hashes: { netlist: hash(input), cst: hash(cst), native: hash(readFileSync(executable)), wasi: hash(readFileSync(wasmExecutable)),
    native_chipdb: hash(nativeChipdb), wasi_chipdb: hash(wasiChipdb),
    native_build_info: buildInfoHash(executable), wasi_build_info: buildInfoHash(wasmExecutable),
    script: hash(readFileSync(import.meta.filename)), helper: hash(readFileSync(path.join(root, "tests/synth/nextpnr-helpers.mjs"))) },
};
writeFileSync(path.join(out, "metadata.json"), JSON.stringify(metadata, null, 2), { flag: "wx" });
const rows = [];
const previous = new Map();
let resources;
let failed = false;
for (let repeat = 1; repeat <= repeats; repeat += 1) {
  const order = repeat % 2 ? ["native", "wasi"] : ["wasi", "native"];
  const runs = {};
  const runRows = [];
  for (const backend of order) {
    const directory = path.join(out, `${backend}-${repeat}`);
    mkdirSync(directory);
    mkdirSync(path.join(directory, "constraints"));
    mkdirSync(path.join(directory, "tmp"));
    writeFileSync(path.join(directory, "top.json"), input, { flag: "wx" });
    writeFileSync(path.join(directory, "constraints/board.cst"), cst, { flag: "wx" });
    const native = values["native-binary"] || values["native-share"] ? (directory) => spawnSync(executable, nativeArgs, {
      cwd: directory, encoding: "utf8", env: { ...process.env, TMPDIR: path.join(directory, "tmp") }, maxBuffer: 16 * 1024 * 1024,
    }) : runNative;
    const run = backend === "native" ? native : (directory, args) => runWasi(directory, args, wasiShare, wasm);
    const started = performance.now();
    const result = run(directory, args);
    runs[backend] = result;
    const elapsed = performance.now() - started;
    writeFileSync(path.join(directory, "stdout.log"), result.stdout);
    writeFileSync(path.join(directory, "stderr.log"), result.stderr);
    const row = { repeat, backend, status: "failed", layout_sha256: "", elapsed_ms: result.elapsed ?? elapsed,
      wasi_memory_bytes: result.memoryBytes ?? null, exit_status: result.status, signal: result.signal ?? null,
      execution_error: executionErrorDetails(result.error) };
    try {
      if (!values["expect-capacity"]) assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`);
      assert.ok(Number.isFinite(row.elapsed_ms) && row.elapsed_ms > 0, "Invalid elapsed time");
      const utilization = parseDeviceUtilization(result.stderr, { allowExceeded: values["expect-capacity"] });
      if (resources) assert.deepEqual(utilization, resources);
      resources = utilization;
      if (values["expect-capacity"]) {
        row.status = "capacity-exceeded";
      } else {
        const routed = JSON.parse(readFileSync(path.join(directory, "pnr.json")));
        row.layout_sha256 = hash(JSON.stringify(routed));
        if (previous.has(backend)) assert.equal(row.layout_sha256, previous.get(backend), "Same-backend placement is not self-reproducible");
        previous.set(backend, row.layout_sha256);
        row.status = "passed";
      }
    } catch (error) {
      row.error = error.stack ?? String(error);
      failed = true;
    }
    rows.push(row);
    runRows.push({ row, directory });
  }
  if (values["expect-capacity"]) {
    try {
      assert.ok(isCapacityExceeded(runs.wasi, runs.native, resources ?? {}), "Expected matching native/WASI capacity failures");
    } catch (error) {
      failed = true;
      for (const { row } of runRows) {
        row.status = "failed";
        row.error = error.stack ?? String(error);
      }
    }
  }
  for (const { row, directory } of runRows) {
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(row, null, 2), { flag: "wx" });
    console.log(`${repeat}/${repeats} ${row.backend}: ${row.status} ${row.layout_sha256}`);
  }
}
const summary = { failed, resources, cross_backend_same: previous.has("native") && previous.get("native") === previous.get("wasi"), rows };
writeFileSync(path.join(out, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
const csvValue = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
writeFileSync(path.join(out, "results.csv"), "repeat,backend,status,layout_sha256,elapsed_ms,wasi_memory_bytes,exit_status,signal,execution_error_name,execution_error_message\n" + rows.map((row) => [row.repeat, row.backend, row.status, row.layout_sha256, row.elapsed_ms, row.wasi_memory_bytes,
  row.exit_status, row.signal, row.execution_error?.name, row.execution_error?.message].map(csvValue).join(",")).join("\n") + "\n", { flag: "wx" });
if (failed) process.exitCode = 1;
