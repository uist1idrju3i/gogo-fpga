import assert from "node:assert/strict";
import test from "node:test";
import { createProposalEditor, parseProposals, proposalDiff, proposalSnapshot, validateProposals } from "../../web/lib/ai-proposals.mjs";

const initial = () => new Map([["src/top.v", "old\n"], ["constraints/tangnano9k.cst", "pins"], ["libraries/demo/sources/x.v", "library"], ["build/top.fs", new Uint8Array([0, 1])]]);
const change = (path = "src/top.v", content = "new\n") => ({ path, content, reason: "test" });
test("proposal fences, unified diffs, malformed JSON and no proposal", () => {
  const files = initial();
  assert.equal(parseProposals("plain text", files).valid.length, 0);
  assert.equal(parseProposals("```gogo-fpga-changes\n{bad}\n```", files).valid.length, 0);
  const parsed = parseProposals(`説明\n\`\`\`gogo-fpga-changes\n${JSON.stringify({ changes: [change()] })}\n\`\`\``, files);
  assert.equal(parsed.valid.length, 1);
  const diff = proposalDiff(parsed.valid[0], files);
  assert.match(diff, /-old\n\+new/); assert.match(diff, /@@/);
  assert.equal(validateProposals([change("src/new.vhd")], files).valid.length, 1);
});
test("malicious paths, generated constraints, libraries, binary, duplicates and limits are rejected", () => {
  const files = initial();
  for (const path of ["../x.v", "/etc/x.v", "a/../../b.v", "src\\x.v", "src//x.v", "./src/x.v", "src/\0x.v", "src/x\nv.v", "%2e%2e/x.v", "C:/x.v", "project.json", "constraints/tangnano9k.cst", "libraries/demo/sources/x.v", "build/top.fs", "build/new.v", "src/new.txt", "src/top.v/child.v"]) {
    assert.equal(validateProposals([change(path)], files).valid.length, 0, path);
  }
  for (const value of [null, {}, [change(), change()], [change("src/top.v", 1)], [change("src/top.v", "a\0b")], [change("src/top.v", "x".repeat(131073))], Array.from({ length: 9 }, (_, i) => change(`src/f${i}.v`))]) {
    assert.equal(validateProposals(value, files).valid.length, 0);
  }
  assert.equal(validateProposals([], files).rejected.length, 0);
  assert.equal(validateProposals(Array.from({ length: 5 }, (_, i) => change(`src/f${i}.v`, "a".repeat(131072))), files).valid.length, 0);
});

function fixture() {
  let current = { projectId: "id", revision: 0, project: { name: "test" }, files: initial() };
  let saves = 0, busy = false, failure = false;
  const editor = createProposalEditor({ getWorkspace: () => current, isBusy: () => busy, saveRevision: async (next) => {
    if (failure) throw new Error("save failed");
    saves++; current = { ...next, revision: current.revision + 1, stale: true };
  } });
  return { editor, get current() { return current; }, get saves() { return saves; }, busy: () => { busy = true; }, fail: () => { failure = true; } };
}
test("accepted files form exactly one stale revision, undo restores/deletes in exactly one revision", async () => {
  const f = fixture(), snapshot = await proposalSnapshot(f.current);
  await f.editor.apply([change(), change("src/new.v", "created")], snapshot);
  assert.equal(f.saves, 1); assert.equal(f.current.revision, 1); assert.equal(f.current.stale, true);
  assert.equal(f.current.files.get("src/top.v"), "new\n");
  await f.editor.undo();
  assert.equal(f.saves, 2); assert.equal(f.current.files.get("src/top.v"), "old\n");
  assert.equal(f.current.files.has("src/new.v"), false); assert.equal(f.editor.canUndo, false);
  await assert.rejects(f.editor.undo(), { code: "empty" });
});
test("snapshot conflict, project switch, busy, failed save and changed undo cannot overwrite", async () => {
  for (const mode of ["changed", "project", "busy", "failure"]) {
    const f = fixture(), snapshot = await proposalSnapshot(f.current);
    if (mode === "changed") f.current.files.set("src/top.v", "edited");
    if (mode === "project") f.current.projectId = "other";
    if (mode === "busy") f.busy();
    if (mode === "failure") f.fail();
    await assert.rejects(f.editor.apply([change()], snapshot)); assert.equal(f.saves, 0); assert.equal(f.editor.canUndo, false);
  }
  const f = fixture(), snapshot = await proposalSnapshot(f.current);
  await f.editor.apply([change()], snapshot); f.current.files.set("src/top.v", "edited later");
  await assert.rejects(f.editor.undo(), { code: "changed" }); assert.equal(f.saves, 1);
});

test("empty acceptance and concurrent apply never produce extra revisions", async () => {
  const f = fixture(), snapshot = await proposalSnapshot(f.current);
  await assert.rejects(f.editor.apply([], snapshot), { code: "empty" });
  const first = f.editor.apply([change()], snapshot);
  await assert.rejects(f.editor.apply([change()], snapshot), { code: "busy" });
  await first; assert.equal(f.saves, 1);
});
