import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import test from "node:test";
import { attachBytePipe, createBytePipe } from "../../web/lib/byte-pipe.mjs";
import { applyWorkspaceDelta } from "../../web/lib/formal-workspace.mjs";

globalThis.crossOriginIsolated = true;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const manifest = JSON.parse(readFileSync(new URL("../../build/synth/manifest.json", import.meta.url)));
const binaries = Object.fromEntries(manifest.assets.map(asset => [asset.path, asset]));
const wasm = new Uint8Array(readFileSync(new URL("../../build/synth/yosys.wasm", import.meta.url)));
const share = new Uint8Array(readFileSync(new URL("../../build/synth/yosys-share.tar", import.meta.url)));
const files = [
  { path: "result/src/top.v", bytes: encoder.encode("module top(); endmodule\n") },
  { path: "result/model/design.ys", bytes: encoder.encode("read -formal top.v\nprep -top top\nhierarchy -smtcheck\nwrite_rtlil ../model/design.il\n") },
];

async function run(overrides = {}) {
  const worker = new Worker(new URL("../web/formal-wasi-node-worker.mjs", import.meta.url), { execArgv: [] });
  const channels = { stdout: createBytePipe(), stderr: createBytePipe() };
  try {
    const response = new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`WASI worker exited without response: ${code}`)));
    });
    worker.postMessage({
      jobId: "test", wasm, sha256: binaries["yosys.wasm"].sha256,
      share, shareSha256: binaries["yosys-share.tar"].sha256,
      cwd: "result/src", args: ["yosys", "-ql", "../model/design.log", "../model/design.ys"],
      files, channels, ...overrides,
    });
    const result = await response;
    const stderr = attachBytePipe(channels.stderr, "reader");
    const stdout = attachBytePipe(channels.stdout, "reader");
    return { result, stderr: decoder.decode(stderr.readAvailable(1024 * 1024) ?? new Uint8Array()),
      stdout: decoder.decode(stdout.readAvailable(1024 * 1024) ?? new Uint8Array()) };
  } finally { await worker.terminate(); }
}

test("Yosys child worker preserves upstream output, propagates true exit, and returns only file changes", async () => {
  const { result, stderr } = await run();
  assert.equal(result.type, "exit", stderr);
  assert.equal(result.result.exitCode, 0, stderr);
  const current = [...files, { path: "result/logfile.txt", bytes: encoder.encode("root wrote this after spawn") }];
  const merged = await applyWorkspaceDelta(current, result.frame);
  assert.equal(decoder.decode(merged.find(file => file.path === "result/logfile.txt").bytes), "root wrote this after spawn");
  assert.match(decoder.decode(merged.find(file => file.path === "result/model/design.il").bytes), /module \\top/);
  assert.ok(merged.find(file => file.path === "result/model/design.log").bytes.length > 0);
  assert.equal(merged.find(file => file.path === "result/src/top.v").bytes.length, files[0].bytes.length);
});

test("Yosys child worker rejects altered binary, shell syntax, and filesystem escape", async () => {
  const changed = new Uint8Array(wasm);
  changed[0] ^= 1;
  const corrupt = await run({ wasm: changed });
  assert.equal(corrupt.result.type, "failure");
  assert.equal(corrupt.result.status, "integrity-error");
  const command = await run({ args: ["yosys", "-ql", "../model/design.log; echo wrong", "../model/design.ys"] });
  assert.equal(command.result.status, "setup-error");
  const directory = await run({ cwd: "../../etc" });
  assert.equal(directory.result.status, "setup-error");
});

test("Yosys child worker keeps ordinary nonzero process exits separate from transport failures", async () => {
  const broken = files.map(file => file.path.endsWith("top.v") ?
    { ...file, bytes: encoder.encode("this is not Verilog\n") } : file);
  const { result, stderr } = await run({ files: broken });
  assert.equal(result.type, "exit");
  assert.equal(result.result.exitCode, 1);
  assert.match(stderr, /syntax error/);
  assert.ok(result.frame instanceof Uint8Array);
  const merged = await applyWorkspaceDelta(broken, result.frame);
  assert.ok(merged.find(file => file.path === "result/model/design.log"));
});
