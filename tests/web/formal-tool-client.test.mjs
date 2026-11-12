import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { attachBytePipe } from "../../web/lib/byte-pipe.mjs";
import { createFormalToolClient } from "../../web/lib/formal-tool-client.mjs";
import { packWorkspaceDelta } from "../../web/lib/formal-workspace.mjs";

globalThis.crossOriginIsolated = true;

test("SBY client drains filesystem frames larger than pipe capacity before child completion", async () => {
  let request;
  const client = createFormalToolClient(data => { request = data; }, "job", { readdir: () => [".", ".."] });
  const handle = client.spawn_process({ toJs: () => ["yosys", "-ql", "design.log", "design.ys"] }, "result/model");
  assert.equal(request.type, "spawn-process");
  const stdout = attachBytePipe(request.channels.stdout, "writer");
  const stderr = attachBytePipe(request.channels.stderr, "writer");
  const delta = attachBytePipe(request.channels.delta, "writer");
  const control = new Int32Array(request.control);
  const frame = await packWorkspaceDelta([], [{ path: "output", bytes: new Uint8Array(200_000).fill(42) }]);
  const transfer = (async () => {
    await stdout.writeAsync(new TextEncoder().encode("one line\n"));
    stdout.end(); stderr.end();
    await delta.writeAsync(frame);
    delta.end();
    Atomics.store(control, 1, 1);
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
  })();
  const deadline = performance.now() + 5000;
  while (handle.poll() === undefined) {
    assert.ok(performance.now() < deadline, "delta transfer must not deadlock");
    await setImmediate();
  }
  await transfer;
  assert.equal(handle.poll(), 1);
  assert.equal(new TextDecoder().decode(handle.readline()), "one line\n");
  assert.deepEqual(handle.take_delta(), frame);
  assert.throws(() => handle.take_delta(), /Invalid/);
});
