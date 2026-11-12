import assert from "node:assert/strict";
import test from "node:test";
import { applyWorkspaceDelta, packWorkspaceDelta } from "../../web/lib/formal-workspace.mjs";

const bytes = text => new TextEncoder().encode(text);
const file = (path, text) => ({ path, bytes: bytes(text) });

function editManifest(frame, change) {
  const originalLength = new DataView(frame.buffer).getUint32(0, true);
  const manifest = JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + originalLength)));
  change(manifest);
  const header = bytes(JSON.stringify(manifest));
  const output = new Uint8Array(4 + header.length + frame.length - 4 - originalLength);
  new DataView(output.buffer).setUint32(0, header.length, true);
  output.set(header, 4);
  output.set(frame.subarray(4 + originalLength), 4 + header.length);
  return output;
}

test("workspace delta keeps independent root writes while applying changed, added, and removed child files", async () => {
  const before = [file("top.v", "input"), file("result/logfile.txt", "root"),
    file("result/model/input.ys", "script"), file("result/model/obsolete", "old")];
  const after = [file("top.v", "input"), file("result/logfile.txt", "root"),
    file("result/model/input.ys", "modified"), file("result/model/output.json", "output")];
  const delta = await packWorkspaceDelta(before, after);
  const rootNow = [...before.filter(item => item.path !== "result/logfile.txt"), file("result/logfile.txt", "root later")];
  const result = await applyWorkspaceDelta(rootNow, delta);
  assert.deepEqual(result.map(item => [item.path, new TextDecoder().decode(item.bytes)]), [
    ["result/logfile.txt", "root later"], ["result/model/input.ys", "modified"],
    ["result/model/output.json", "output"], ["top.v", "input"],
  ]);
  const empty = await packWorkspaceDelta(after, after);
  assert.deepEqual(await applyWorkspaceDelta(after, empty), after.sort((a, b) => a.path < b.path ? -1 : 1));
});

test("workspace delta fails closed for conflicts, corrupt frames, and untrusted paths", async () => {
  const before = [file("result/input", "original")];
  const after = [file("result/input", "updated"), file("result/output", "artifact")];
  const delta = await packWorkspaceDelta(before, after);
  await assert.rejects(applyWorkspaceDelta([file("result/input", "root changed")], delta), /conflict/);
  await assert.rejects(applyWorkspaceDelta([...before, file("result/output", "root file")], delta), /conflict/);
  await assert.rejects(applyWorkspaceDelta(before, delta.subarray(0, delta.length - 1)), /Truncated/);
  await assert.rejects(applyWorkspaceDelta(before, new Uint8Array([...delta, 1])), /Unexpected/);
  const mutated = new Uint8Array(delta);
  mutated[mutated.length - 1] ^= 1;
  await assert.rejects(applyWorkspaceDelta(before, mutated), /hash mismatch/);
  for (const path of ["../outside", "/absolute", "a//b", "a\\b", "result/\0a"]) {
    const invalid = editManifest(delta, header => { header.changes[0].path = path; });
    await assert.rejects(applyWorkspaceDelta(before, invalid), /Invalid workspace delta entry/);
  }
  const wrongHash = editManifest(delta, header => { header.changes[0].beforeSha256 = "f".repeat(64); });
  await assert.rejects(applyWorkspaceDelta(before, wrongHash), /conflict/);
  const repeated = editManifest(delta, header => { header.changes.push({ ...header.changes[1] }); });
  await assert.rejects(applyWorkspaceDelta(before, repeated), /Invalid workspace delta entry/);
  const malformedLength = new Uint8Array(delta);
  new DataView(malformedLength.buffer).setUint32(0, 0xffffffff, true);
  await assert.rejects(applyWorkspaceDelta(before, malformedLength), /Truncated/);
  await assert.rejects(packWorkspaceDelta([file("../outside", "x")], []), /Invalid workspace file/);
  await assert.rejects(packWorkspaceDelta([...before, ...before], []), /Invalid workspace file/);
  await assert.rejects(packWorkspaceDelta([file("parent", "a"), file("parent/child", "b")], []), /Conflicting workspace path/);
  await assert.rejects(packWorkspaceDelta([], [{ path: "huge", bytes: new Uint8Array(32 * 1024 * 1024 + 1) }]), /size limit/);
});
