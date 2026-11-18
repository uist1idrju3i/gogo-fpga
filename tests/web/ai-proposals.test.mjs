import assert from "node:assert/strict";
import test from "node:test";
import { PROPOSAL_LIMITS, createProposalEditor, parseProposals, proposalDiff, proposalSnapshot, validateProposals } from "../../web/lib/ai-proposals.mjs";

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
  assert.doesNotMatch(diff, /^Index:|^=+$/m);
  assert.match(diff, /^--- src\/top.v\t送信時\n\+\+\+ src\/top.v\t提案\n/);
  assert.equal(proposalDiff(change("src/top.v", "old\n"), files).includes("@@"), false);
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

const partial = (edits, path = "src/top.v") => ({ path, edits, reason: "部分編集" });
test("partial edits use exact sequential matches and literal replacement text", () => {
  const files = new Map([["src/top.v", "日本語\r\nold\n"]]);
  const result = validateProposals([partial([
    { search: "old", replace: "$&new" },
    { search: "$&new", replace: "new\nnext" },
    { search: "日本語\r\n", replace: "" },
  ])], files);
  assert.deepEqual(result, { valid: [{ path: "src/top.v", content: "new\nnext\n", reason: "部分編集" }], rejected: [] });
  assert.equal(files.get("src/top.v"), "日本語\r\nold\n");
});
test("failed matching rejects the entire file, including overlapping and later matches", () => {
  const files = new Map([["src/top.v", "aaa\nold\n"]]);
  for (const [edits, reason] of [
    [[{ search: "missing", replace: "x" }], /一致する箇所がありません/],
    [[{ search: "aa", replace: "x" }], /複数/],
    [[{ search: "old", replace: "new" }, { search: "old", replace: "x" }], /置換2.*一致する箇所がありません/],
    [[{ search: "old", replace: "aaa" }, { search: "aaa", replace: "x" }], /置換2.*複数/],
  ]) {
    const result = validateProposals([partial(edits), change("tests/ok.v", "valid")], files);
    assert.deepEqual(result.valid.map(({ path }) => path), ["tests/ok.v"]);
    assert.match(result.rejected[0].reason, reason);
    assert.equal(files.get("src/top.v"), "aaa\nold\n");
  }
});
test("partial edits reject empty or malformed edits, conflicting forms and new files", () => {
  const files = initial();
  for (const edits of [[], {}, "old", [null], [{ search: "", replace: "x" }], [{ search: 1, replace: "x" }],
    [{ search: "old", replace: null }], [{ search: "old" }], [{ search: "old", replace: "new", extra: true }]]) {
    const result = validateProposals([partial(edits)], files);
    assert.equal(result.valid.length, 0);
    assert.equal(result.rejected.length, 1);
  }
  assert.match(validateProposals([partial([{ search: "x", replace: "y" }], "src/new.v")], files).rejected[0].reason, /新しいファイル/);
  assert.match(validateProposals([{ ...partial([{ search: "old", replace: "new" }]), content: "whole" }], files).rejected[0].reason, /一方だけ/);
  assert.equal(validateProposals([{ path: "src/top.v", content: null, edits: null }], files).valid.length, 0);
});
test("assembled partial edits retain all limits and protected path checks", () => {
  const files = initial();
  const edits = [{ search: "old", replace: "new" }];
  for (const path of ["constraints/tangnano9k.cst", "libraries/demo/sources/x.v", "build/top.fs", "../bad.v"]) {
    files.set(path, "old");
    assert.equal(validateProposals([partial(edits, path)], files).valid.length, 0);
  }
  assert.equal(validateProposals([partial([{ search: "old", replace: "x".repeat(PROPOSAL_LIMITS.perFile) }])], files).valid.length, 0);
  assert.equal(validateProposals([partial([{ search: "old", replace: "x\0y" }])], files).valid.length, 0);
  const many = new Map(Array.from({ length: 5 }, (_, index) => [`src/f${index}.v`, "x"]));
  const result = validateProposals([...many.keys()].map(path => partial([{ search: "x", replace: "y".repeat(PROPOSAL_LIMITS.perFile) }], path)), many);
  assert.match(result.rejected[0].reason, /512 KiB/);
  assert.equal(result.valid.length, 0);
});
test("edit fences coexist with full-content fences but multiple proposal blocks fail closed", () => {
  const files = initial();
  const fence = `\`\`\`gogo-fpga-edits\n${JSON.stringify({ changes: [partial([{ search: "old", replace: "new" }])] })}\n\`\`\``;
  assert.deepEqual(parseProposals(fence, files).valid, [{ path: "src/top.v", content: "new\n", reason: "部分編集" }]);
  const full = `\`\`\`gogo-fpga-changes\n${JSON.stringify({ changes: [change()] })}\n\`\`\``;
  assert.equal(parseProposals(`${fence}\n${full}`, files).valid.length, 0);
  assert.match(parseProposals("```gogo-fpga-edits\n{bad}\n```", files).rejected[0].reason, /JSON/);
});
test("partial edits apply as one full revision and undo restores the captured file", async () => {
  const f = fixture(), snapshot = await proposalSnapshot(f.current);
  await f.editor.apply([partial([{ search: "old", replace: "new" }])], snapshot);
  assert.equal(f.current.files.get("src/top.v"), "new\n");
  assert.equal(f.saves, 1);
  await f.editor.undo();
  assert.equal(f.current.files.get("src/top.v"), "old\n");
  assert.equal(f.saves, 2);
  const changed = await proposalSnapshot(f.current);
  f.current.files.set("src/top.v", "current\n");
  await assert.rejects(f.editor.apply([partial([{ search: "old", replace: "new" }])], changed), { code: "changed" });
});
