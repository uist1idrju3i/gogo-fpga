import assert from "node:assert/strict";
import test from "node:test";
import { attachBytePipe } from "../../web/lib/byte-pipe.mjs";
import { applyWorkspaceDelta, packWorkspaceDelta } from "../../web/lib/formal-workspace.mjs";
import { startFormalToolProcess } from "../../web/lib/formal-tool-process.mjs";

globalThis.crossOriginIsolated = true;
const bytes = text => new TextEncoder().encode(text);
const files = [{ path: "result/model/design.ys", bytes: bytes("script") }];
const changed = [{ path: "result/model/design.il", bytes: bytes("model") }, ...files];
const yosys = { sha256: "a".repeat(64), shareSha256: "b".repeat(64) };
const data = { processId: "job:tool:1", cwd: "result/model", args: ["yosys", "-ql", "design.log", "design.ys"], files };

function workerFactory(send) {
  const handlers = new Map();
  return () => ({
    postMessage(request) {
      queueMicrotask(() => send(request, (value, type = "message") => handlers.get(type)?.(type === "message" ? { data: value } : value)));
    },
    addEventListener(type, listener) { handlers.set(type, listener); },
    removeEventListener(type) { handlers.delete(type); },
    terminate() {},
  });
}

test("formal tool preserves ordinary nonzero exits, output and a verified complete delta", async () => {
  const frame = await packWorkspaceDelta(files, changed);
  for (const exitCode of [0, 1, 255]) {
    const output = []; const errors = [];
    const job = startFormalToolProcess({ data, yosys, onStdout: chunk => output.push(...chunk), onStderr: chunk => errors.push(...chunk),
      wasiWorkerFactory: workerFactory((request, send) => {
        const stdout = attachBytePipe(request.channels.stdout, "writer");
        const stderr = attachBytePipe(request.channels.stderr, "writer");
        stdout.writeSync(bytes("log\n")); stderr.writeSync(bytes("diagnostic\n")); stdout.end(); stderr.end();
        send({ type: "exit", jobId: request.jobId, integrityVerified: true, ...yosys, frame, result: { exitCode } });
      }) });
    const result = await job.completion;
    assert.equal(result.status, "exited"); assert.equal(result.exitCode, exitCode); assert.equal(result.integrityVerified, true);
    assert.equal(new TextDecoder().decode(Uint8Array.from(output)), "log\n");
    assert.equal(new TextDecoder().decode(Uint8Array.from(errors)), "diagnostic\n");
    assert.deepEqual(await applyWorkspaceDelta(files, result.frame), changed);
  }
});

test("formal tool rejects malformed, unverified, corrupt or misidentified WASI completions", async () => {
  const frame = await packWorkspaceDelta(files, changed);
  const valid = { type: "exit", jobId: data.processId, integrityVerified: true, ...yosys, frame, result: { exitCode: 0 } };
  const corrupt = frame.slice(); corrupt[corrupt.length - 1] ^= 1;
  for (const update of [{ integrityVerified: false }, { jobId: "old" }, { sha256: "wrong" }, { shareSha256: "wrong" },
    { result: { exitCode: -1 } }, { result: { exitCode: 256 } }, { frame: null }, { frame: corrupt }, { type: "PASS" }]) {
    const job = startFormalToolProcess({ data, yosys, onStdout() {}, onStderr() {},
      wasiWorkerFactory: workerFactory((request, send) => send({ ...valid, ...update })) });
    assert.equal((await job.completion).status, "transport-error");
  }
});

test("formal tool separates cancellation, crash, decoding and startup failures", async () => {
  for (const [type, status] of [["error", "crashed"], ["messageerror", "protocol-error"]]) {
    const job = startFormalToolProcess({ data, yosys, onStdout() {}, onStderr() {},
      wasiWorkerFactory: workerFactory((request, send) => send({ message: "broken" }, type)) });
    assert.equal((await job.completion).status, status);
  }
  const cancelled = startFormalToolProcess({ data, yosys, onStdout() {}, onStderr() {}, wasiWorkerFactory: workerFactory(() => {}) });
  cancelled.cancel(); assert.equal((await cancelled.completion).status, "cancelled");
  const setup = startFormalToolProcess({ data, yosys, onStdout() {}, onStderr() {},
    wasiWorkerFactory: () => ({ addEventListener() {}, removeEventListener() {}, terminate() {}, postMessage() { throw new Error("startup"); } }) });
  assert.equal((await setup.completion).status, "setup-error");
});

test("formal Python tool packs its private changes without promoting engine failure to transport failure", async () => {
  let request;
  const result = { status: "exited", integrityVerified: true, exitCode: 1, files: changed, children: [{ status: "exited" }] };
  const job = startFormalToolProcess({ data: { ...data, cwd: "result", args: ["yosys-smtbmc", "-s", "yices", "--noprogress", "-t", "2", "model/design_smt2.smt2"] },
    pythonFactory: options => { request = options; return { completion: Promise.resolve(result) }; },
    onStdout() {}, onStderr() {}, timeoutMs: 1000 });
  const completed = await job.completion;
  assert.equal(request.entrypoint, "smtbmc"); assert.equal(request.cwd, "result"); assert.equal(request.timeoutMs, 1000);
  assert.equal(completed.status, "exited"); assert.equal(completed.exitCode, 1);
  assert.deepEqual(await applyWorkspaceDelta(files, completed.frame), changed);
  for (const failure of ["timeout", "cancelled", "crashed", "protocol-error", "integrity-error"]) {
    const failed = startFormalToolProcess({ data: { ...data, args: ["yosys-witness", "aiw2yw", "model/design_aiger.ywa", "engine_0/trace.aiw", "engine_0/trace.yw"] },
      pythonFactory: () => ({ completion: Promise.resolve({ status: failure }) }), onStdout() {}, onStderr() {} });
    assert.equal((await failed.completion).status, failure);
  }
});
