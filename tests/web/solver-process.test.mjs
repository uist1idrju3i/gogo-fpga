import assert from "node:assert/strict";
import test from "node:test";
import { startSolverProcess } from "../../web/lib/solver-process.mjs";
import { commandWasm, nodeSolverWorker, sha256, stdioWasm } from "./solver-process-helpers.mjs";

globalThis.crossOriginIsolated = true;

function start(t, overrides = {}, mode = "normal") {
  const wasm = commandWasm();
  const process = startSolverProcess({ wasm, sha256: sha256(wasm), args: ["fixture"], timeoutMs: 2000,
    workerFactory: () => nodeSolverWorker(mode), ...overrides });
  t.after(() => process.cancel());
  return process;
}

test("solver process validates input and isolation before starting a worker", (t) => {
  let started = false;
  const workerFactory = () => { started = true; };
  for (const invalid of [{ wasm: null }, { sha256: "missing" }, { args: [] }, { args: ["bad\0arg"] },
    { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 300001 }, { maxOutputBytes: 8388609 },
    { onStdout: null }, { capacity: 0 }]) {
    assert.throws(() => start(t, { workerFactory, ...invalid }));
  }
  globalThis.crossOriginIsolated = false;
  try { assert.throws(() => start(t, { workerFactory }), { code: "isolation-required" }); }
  finally { globalThis.crossOriginIsolated = true; }
  assert.equal(started, false);
});

test("solver process requires real exit acknowledgement and both stream EOFs", { timeout: 5000 }, async (t) => {
  const process = start(t);
  const result = await process.completion;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.integrityVerified, true);
  assert.equal(result.memoryBytes, 65536);
  assert.equal(result.stdoutBytes, 0);
  assert.equal(result.stderrBytes, 0);
  assert.equal(result.jobId, process.jobId);
  assert.ok(result.elapsedMs > 0);
  await assert.rejects(process.write(new Uint8Array([1])), /closed/);
  assert.throws(() => process.endInput(), /closed/);
  process.cancel();
  assert.equal((await process.completion).status, "exited");
});

test("solver process rejects a corrupt WASM binary independently from a digest mismatch", { timeout: 5000 }, async (t) => {
  const bad = new Uint8Array([0, 1, 2, 3]);
  const corrupt = await start(t, { wasm: bad, sha256: sha256(bad) }).completion;
  assert.equal(corrupt.status, "invalid-wasm");
  assert.equal(corrupt.integrityVerified, true);
  assert.equal(corrupt.exitCode, null);
  const mismatch = await start(t, { sha256: "0".repeat(64) }).completion;
  assert.equal(mismatch.status, "integrity-error");
  assert.equal(mismatch.integrityVerified, false);
  assert.equal(mismatch.exitCode, null);
});

test("solver process classifies a WASM trap as a runtime error, not an exit or a proof", { timeout: 5000 }, async (t) => {
  const wasm = commandWasm([0]);
  const result = await start(t, { wasm, sha256: sha256(wasm) }).completion;
  assert.equal(result.status, "runtime-error");
  assert.equal(result.exitCode, null);
  assert.equal(result.integrityVerified, true);
});

test("solver process kills a non-cooperative WASM loop at the host deadline", { timeout: 5000 }, async (t) => {
  const wasm = commandWasm([3, 64, 12, 0, 11]);
  const result = await start(t, { wasm, sha256: sha256(wasm), timeoutMs: 200 }).completion;
  assert.equal(result.status, "timeout");
  assert.equal(result.exitCode, null);
});

test("solver process cancellation rejects a blocked write and does not affect a fresh job", { timeout: 5000 }, async (t) => {
  const wasm = commandWasm([3, 64, 12, 0, 11]);
  const first = start(t, { wasm, sha256: sha256(wasm), capacity: 1 });
  const writing = first.write(new Uint8Array([1, 2]));
  first.cancel();
  await assert.rejects(writing, { code: "cancelled" });
  assert.equal((await first.completion).status, "cancelled");
  const second = start(t);
  assert.notEqual(first.jobId, second.jobId);
  assert.equal((await second.completion).status, "exited");
});

for (const [mode, status] of [["crash", "crashed"], ["missing", "timeout"], ["missing-termination", "timeout"],
  ["invalid", "protocol-error"], ["memory", "memory-limit"]]) {
  test(`solver process fails closed for ${mode}`, { timeout: 5000 }, async (t) => {
    const result = await start(t, { timeoutMs: mode.startsWith("missing") ? 200 : 2000 }, mode).completion;
    assert.equal(result.status, status);
    assert.equal(result.exitCode, null);
  });
}

test("solver process ignores an old job ID without adopting its result", { timeout: 5000 }, async (t) => {
  const result = await start(t, {}, "stale").completion;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
});

test("solver process drains long split output and separate stderr before accepting a nonzero exit", { timeout: 15000 }, async (t) => {
  const wasm = stdioWasm({ stdoutLength: 4096, repeat: 129, exitCode: 19 });
  assert.equal(WebAssembly.validate(wasm), true);
  const stdout = [];
  const stderr = [];
  let chunks = 0;
  const result = await start(t, {
    wasm, sha256: sha256(wasm), capacity: 251, timeoutMs: 10000,
    async onStdout(bytes) {
      stdout.push(bytes);
      chunks++;
      await new Promise(resolve => setImmediate(resolve));
    },
    onStderr: bytes => stderr.push(bytes),
  }).completion;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 19);
  assert.equal(result.stdoutBytes, 4096 * 129);
  assert.equal(result.stderrBytes, 17);
  assert.ok(chunks > 129);
  assert.deepEqual(Buffer.concat(stdout), Buffer.alloc(4096 * 129, 79));
  assert.deepEqual(Buffer.concat(stderr), Buffer.alloc(17, 69));
});

test("solver process keeps stdout and stderr emitted before a WASM trap", { timeout: 5000 }, async (t) => {
  const wasm = stdioWasm({ trap: true });
  const stdout = [];
  const stderr = [];
  const result = await start(t, { wasm, sha256: sha256(wasm), capacity: 7,
    onStdout: bytes => stdout.push(bytes), onStderr: bytes => stderr.push(bytes) }).completion;
  assert.equal(result.status, "runtime-error");
  assert.equal(result.exitCode, null);
  assert.deepEqual(Buffer.concat(stdout), Buffer.alloc(64, 79));
  assert.deepEqual(Buffer.concat(stderr), Buffer.alloc(17, 69));
});

test("solver process enforces the combined stdout and stderr budget", { timeout: 5000 }, async (t) => {
  const wasm = stdioWasm({ stdoutLength: 64, stderrLength: 17 });
  let seen = 0;
  const result = await start(t, { wasm, sha256: sha256(wasm), capacity: 7, maxOutputBytes: 80,
    onStdout: bytes => { seen += bytes.length; }, onStderr: bytes => { seen += bytes.length; } }).completion;
  assert.equal(result.status, "output-limit");
  assert.equal(result.exitCode, null);
  assert.equal(result.stdoutBytes + result.stderrBytes, seen);
  assert.ok(seen <= 80);
});

test("solver process fails closed when a stream consumer throws or never settles", { timeout: 5000 }, async (t) => {
  const wasm = stdioWasm();
  const options = { wasm, sha256: sha256(wasm), capacity: 7 };
  const thrown = await start(t, { ...options, onStdout() { throw new Error("Consumer failed"); } }).completion;
  assert.equal(thrown.status, "transport-error");
  const stalled = await start(t, { ...options, timeoutMs: 200, onStdout: () => new Promise(() => {}) }).completion;
  assert.equal(stalled.status, "timeout");
});
