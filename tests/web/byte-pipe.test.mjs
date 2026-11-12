import assert from "node:assert/strict";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { attachBytePipe, createBytePipe } from "../../web/lib/byte-pipe.mjs";

// Node fixtures do not verify the browser's isolation headers.
globalThis.crossOriginIsolated = true;
const moduleUrl = new URL("../../web/lib/byte-pipe.mjs", import.meta.url).href;

function pair(capacity = 3) {
  const descriptor = createBytePipe(capacity);
  return { descriptor, reader: attachBytePipe(descriptor, "reader"), writer: attachBytePipe(descriptor, "writer") };
}

function worker(t, data, script) {
  const instance = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    globalThis.crossOriginIsolated = true;
    import(${JSON.stringify(moduleUrl)}).then(({ attachBytePipe }) => {
      ${script}
    }).catch(error => { throw error; });
  `, { eval: true, workerData: data });
  t.after(() => instance.terminate());
  return instance;
}

test("byte pipes require isolation, bounded shared storage and a single endpoint per role", () => {
  const descriptor = createBytePipe();
  globalThis.crossOriginIsolated = false;
  try {
    assert.throws(() => createBytePipe(), { code: "isolation-required" });
    assert.throws(() => attachBytePipe(descriptor, "reader"), { code: "isolation-required" });
  } finally { globalThis.crossOriginIsolated = true; }
  for (const capacity of [0, -1, 1.5, NaN, Infinity, 1048577, "10"]) {
    assert.throws(() => createBytePipe(capacity), RangeError);
  }
  for (const invalid of [null, {}, { version: 2, buffer: descriptor.buffer },
    { version: 1, buffer: new ArrayBuffer(64) }, { version: 1, buffer: new SharedArrayBuffer(21) }]) {
    assert.throws(() => attachBytePipe(invalid, "reader"), TypeError);
  }
  assert.throws(() => attachBytePipe(descriptor, "both"), TypeError);
  attachBytePipe(descriptor, "reader");
  attachBytePipe(descriptor, "writer");
  assert.throws(() => attachBytePipe(descriptor, "reader"), { code: "already-attached" });
  assert.throws(() => attachBytePipe(descriptor, "writer"), { code: "already-attached" });
});

test("byte pipes wrap without truncation, preserve short reads and drain before EOF", () => {
  const { reader, writer } = pair();
  writer.writeSync(new Uint8Array([1, 2, 3]));
  assert.deepEqual(reader.readSync(2), new Uint8Array([1, 2]));
  assert.equal(reader.readSync(0).length, 0);
  writer.writeSync(new Uint8Array([4, 5]));
  writer.end();
  assert.deepEqual(reader.readSync(10), new Uint8Array([3, 4]));
  assert.deepEqual(reader.readSync(10), new Uint8Array([5]));
  assert.equal(reader.readSync(10).length, 0);
  assert.throws(() => writer.writeSync(new Uint8Array()), { code: "closed" });
  assert.throws(() => writer.end(), { code: "closed" });
});

test("byte pipe polling distinguishes no data, buffered bytes and EOF without consuming during waits", () => {
  const { reader, writer } = pair();
  assert.equal(reader.readAvailable(2), null);
  assert.equal(reader.waitReadableSync(0), false);
  const start = performance.now();
  assert.equal(reader.waitReadableSync(5), false);
  assert.ok(performance.now() - start >= 4);
  for (const timeout of [-1, NaN, Infinity, 300001, "1"]) {
    assert.throws(() => reader.waitReadableSync(timeout), RangeError);
  }
  for (const size of [-1, NaN, Infinity, 1.5, 8388609]) {
    assert.throws(() => reader.readAvailable(size), RangeError);
  }
  writer.writeSync(new Uint8Array([1, 2]));
  assert.equal(reader.waitReadableSync(0), true);
  assert.deepEqual(reader.readAvailable(2), new Uint8Array([1, 2]));
  writer.end();
  assert.equal(reader.waitReadableSync(0), true);
  assert.deepEqual(reader.readAvailable(2), new Uint8Array());
});

test("byte pipe polling preserves cancellation and closed-state errors", () => {
  for (const method of ["cancel", "close"]) {
    const { reader, writer } = pair();
    writer[method]();
    const expected = { code: method === "cancel" ? "cancelled" : "closed" };
    assert.throws(() => reader.readAvailable(1), expected);
    assert.throws(() => reader.waitReadableSync(0), expected);
  }
});

test("byte pipes reject malformed data, read sizes and corrupted controls", async () => {
  const { reader, writer, descriptor } = pair();
  for (const value of [null, "smt", [1], Promise.resolve(1), new Uint8Array(8388609)]) {
    assert.throws(() => writer.writeSync(value), TypeError);
  }
  for (const size of [-1, 1.5, NaN, Infinity, 8388609]) {
    assert.throws(() => reader.readSync(size), RangeError);
    await assert.rejects(reader.readAsync(size), RangeError);
  }
  writer.writeSync(new Uint8Array([7]));
  assert.deepEqual(reader.readSync(1), new Uint8Array([7]));
  const header = new Int32Array(descriptor.buffer, 0, 5);
  Atomics.store(header, 0, 100);
  assert.throws(() => reader.readSync(1), { code: "corrupt" });
  assert.throws(() => writer.writeSync(new Uint8Array([2])), { code: "corrupt" });
  Atomics.store(header, 0, 0);
  Atomics.store(header, 2, 99);
  assert.throws(() => writer.end(), { code: "corrupt" });
});

test("byte pipes reject missing async atomics before allocating or attaching", () => {
  const descriptor = createBytePipe(1);
  const wait = Atomics.waitAsync;
  Atomics.waitAsync = undefined;
  try {
    assert.throws(() => createBytePipe(1), { code: "async-wait-unavailable" });
    assert.throws(() => attachBytePipe(descriptor, "writer"), { code: "async-wait-unavailable" });
  } finally { Atomics.waitAsync = wait; }
});

test("byte pipe backpressure snapshots caller data and rejects concurrent writes or early EOF", { timeout: 5000 }, async () => {
  const { reader, writer } = pair(1);
  const input = Buffer.from([1, 2, 3]);
  let completed = false;
  const writing = writer.writeAsync(input).then(() => { completed = true; });
  input.fill(9);
  await setImmediate();
  assert.equal(completed, false);
  await assert.rejects(writer.writeAsync(new Uint8Array([4])), { code: "busy" });
  assert.throws(() => writer.end(), { code: "busy" });
  assert.deepEqual(await reader.readAsync(1), new Uint8Array([1]));
  assert.deepEqual(await reader.readAsync(1), new Uint8Array([2]));
  assert.deepEqual(await reader.readAsync(1), new Uint8Array([3]));
  await writing;
  writer.end();
  assert.equal((await reader.readAsync(1)).length, 0);
});

test("byte pipe readers reject overlapping reads and cancellation wakes pending operations", { timeout: 5000 }, async () => {
  const { reader, writer } = pair();
  const reading = reader.readAsync(8);
  await assert.rejects(reader.readAsync(1), { code: "busy" });
  writer.cancel();
  await assert.rejects(reading, { code: "cancelled" });
  writer.close();
  assert.throws(() => reader.readSync(1), { code: "cancelled" });
  assert.throws(() => writer.writeSync(new Uint8Array([1])), { code: "cancelled" });

  const second = pair(1);
  const writing = second.writer.writeAsync(new Uint8Array([1, 2]));
  second.reader.cancel();
  await assert.rejects(writing, { code: "cancelled" });
});

test("closing a byte pipe discards buffered bytes and wakes its blocked peer", { timeout: 5000 }, async () => {
  const { reader, writer } = pair(1);
  const writing = writer.writeAsync(new Uint8Array([1, 2]));
  reader.close();
  reader.cancel();
  await assert.rejects(writing, { code: "closed" });
  assert.throws(() => reader.readSync(1), { code: "closed" });
  await assert.rejects(writer.writeAsync(new Uint8Array()), { code: "closed" });
});

test("a real worker streams both directions through tiny byte pipes with backpressure", { timeout: 10000 }, async (t) => {
  const input = createBytePipe(2);
  const output = createBytePipe(3);
  const writer = attachBytePipe(input, "writer");
  const reader = attachBytePipe(output, "reader");
  const instance = worker(t, { input, output }, `
    const reader = attachBytePipe(workerData.input, "reader");
    const writer = attachBytePipe(workerData.output, "writer");
    let count = 0;
    for (;;) {
      const bytes = reader.readSync(7);
      if (bytes.length === 0) break;
      writer.writeSync(bytes);
      count += bytes.length;
    }
    writer.end();
    reader.close();
    parentPort.postMessage(count);
  `);
  const result = once(instance, "message");
  const expected = Uint8Array.from({ length: 7001 }, (_, index) => index % 251);
  const sending = writer.writeAsync(expected).then(() => writer.end());
  const received = [];
  for (;;) {
    const bytes = await reader.readAsync(5);
    if (bytes.length === 0) break;
    received.push(...bytes);
  }
  await sending;
  assert.deepEqual(await result, [expected.length]);
  assert.deepEqual(new Uint8Array(received), expected);
});

for (const action of ["cancel", "close"]) {
  test(`a real worker observes ${action} while blocked in a byte pipe read`, { timeout: 5000 }, async (t) => {
    const descriptor = createBytePipe(1);
    const writer = attachBytePipe(descriptor, "writer");
    const instance = worker(t, { descriptor }, `
      const reader = attachBytePipe(workerData.descriptor, "reader");
      const wait = Atomics.wait;
      Atomics.wait = (...args) => { parentPort.postMessage("waiting"); return wait(...args); };
      try { reader.readSync(1); }
      catch (error) { parentPort.postMessage({ code: error.code }); }
    `);
    assert.deepEqual(await once(instance, "message"), ["waiting"]);
    const result = once(instance, "message");
    writer[action]();
    assert.deepEqual(await result, [{ code: action === "cancel" ? "cancelled" : "closed" }]);
  });
}

test("a real worker observes cancellation while blocked writing to a full byte pipe", { timeout: 5000 }, async (t) => {
  const descriptor = createBytePipe(1);
  const reader = attachBytePipe(descriptor, "reader");
  const instance = worker(t, { descriptor }, `
    const writer = attachBytePipe(workerData.descriptor, "writer");
    const wait = Atomics.wait;
    Atomics.wait = (...args) => { parentPort.postMessage("waiting"); return wait(...args); };
    try { writer.writeSync(new Uint8Array([1, 2])); }
    catch (error) { parentPort.postMessage({ code: error.code }); }
  `);
  assert.deepEqual(await once(instance, "message"), ["waiting"]);
  const result = once(instance, "message");
  reader.cancel();
  assert.deepEqual(await result, [{ code: "cancelled" }]);
});
