import assert from "node:assert/strict";
import test from "node:test";
import { createWasiP1ImportObject } from "../../web/lib/wasi-p1.mjs";

function stream(options = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wasi = createWasiP1ImportObject(options);
  wasi.initialize({ exports: { memory } });
  const imports = wasi.importObject.wasi_snapshot_preview1;
  return {
    imports,
    read(lengths, fd = 0) {
      const view = new DataView(memory.buffer);
      let offset = 512;
      for (let index = 0; index < lengths.length; index += 1) {
        view.setUint32(index * 8, offset, true);
        view.setUint32(index * 8 + 4, lengths[index], true);
        offset += lengths[index];
      }
      view.setUint32(128, 0xffffffff, true);
      const errno = imports.fd_read(fd, 0, lengths.length, 128);
      const count = view.getUint32(128, true);
      const bytes = errno === 0 ? new Uint8Array(memory.buffer, 512, count).slice() : null;
      return { errno, count, bytes };
    },
  };
}

test("WASI stdin remains EOF by default", () => {
  assert.deepStrictEqual(stream().read([10]), { errno: 0, count: 0, bytes: new Uint8Array() });
});

test("WASI single-thread yield succeeds without consuming input or changing descriptor state", () => {
  let reads = 0;
  const wasi = stream({ stdin() { reads++; return new Uint8Array([42]); } });
  for (let index = 0; index < 3; index++) assert.equal(wasi.imports.sched_yield(), 0);
  assert.equal(reads, 0);
  assert.deepStrictEqual(wasi.read([1]), { errno: 0, count: 1, bytes: new Uint8Array([42]) });
  assert.equal(reads, 1);
  assert.equal(wasi.imports.fd_close(0), 0);
  assert.equal(wasi.imports.sched_yield(), 0);
  assert.notEqual(wasi.read([1]).errno, 0);
});

test("WASI stdin permits incremental reads and short reads without waiting for another iovec", () => {
  const input = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array()];
  const requested = [];
  const wasi = stream({ stdin(size) { requested.push(size); return input.shift(); } });
  assert.deepStrictEqual(wasi.read([8, 8]), { errno: 0, count: 2, bytes: new Uint8Array([1, 2]) });
  assert.deepStrictEqual(wasi.read([8]), { errno: 0, count: 1, bytes: new Uint8Array([3]) });
  assert.deepStrictEqual(wasi.read([8]), { errno: 0, count: 0, bytes: new Uint8Array() });
  assert.deepStrictEqual(requested, [8, 8, 8]);
});

test("WASI stdin copies each full iovec and does not consume bytes for zero-sized reads", () => {
  const requested = [];
  const wasi = stream({ stdin(size) { requested.push(size); return new Uint8Array(size).fill(size); } });
  assert.deepStrictEqual(wasi.read([0, 2, 3]), { errno: 0, count: 5, bytes: new Uint8Array([2, 2, 3, 3, 3]) });
  assert.deepStrictEqual(requested, [2, 3]);
});

for (const value of [null, "hello", new Uint8Array(9), Promise.resolve(new Uint8Array()), [1]]) {
  test(`WASI stdin rejects a reader result that is not bounded synchronous bytes: ${String(value)}`, () => {
    assert.throws(() => stream({ stdin: () => value }).read([8]), /stdin must return/);
  });
}

test("WASI stdin rejects a non-callable reader at construction", () => {
  assert.throws(() => stream({ stdin: new Uint8Array() }), /stdin must be/);
});

test("WASI stdin does not mask exceptions from a cancelled reader", () => {
  const cancelled = new Error("cancelled");
  assert.throws(() => stream({ stdin: () => { throw cancelled; } }).read([8]), error => error === cancelled);
});

test("WASI stdin does not consume input after closing the descriptor or reading a write-only fd", () => {
  let calls = 0;
  const wasi = stream({ stdin() { calls += 1; return new Uint8Array(); } });
  assert.equal(wasi.imports.fd_close(0), 0);
  assert.notEqual(wasi.read([8]).errno, 0);
  assert.notEqual(wasi.read([8], 1).errno, 0);
  assert.notEqual(wasi.read([8], 2).errno, 0);
  assert.equal(calls, 0);
});

test("WASI stdin rejects invalid memory without calling the reader", () => {
  let calls = 0;
  const wasi = stream({ stdin() { calls += 1; return new Uint8Array(); } });
  assert.notEqual(wasi.imports.fd_read(0, 65536, 1, 128), 0);
  assert.notEqual(wasi.imports.fd_read(0, 0, 1, 65536), 0);
  assert.equal(calls, 0);
});
