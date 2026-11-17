import assert from "node:assert/strict";
import test from "node:test";
import { AI_SKILLS, buildSystemPrompt } from "../../web/lib/ai-skills.mjs";
import { PROPOSAL_LIMITS } from "../../web/lib/ai-proposals.mjs";
import { summarizeProject } from "../../web/lib/ai-project-summary.mjs";
import { BOARDS } from "../../web/lib/boards.mjs";

test("all frozen skills include data boundaries and only changing skills include the contract", () => {
  assert.ok(Object.isFrozen(AI_SKILLS));
  assert.deepEqual(AI_SKILLS.map(({ id }) => id), ["consult", "explain", "change", "review", "testbench", "formal"]);
  for (const skill of AI_SKILLS) {
    assert.ok(Object.isFrozen(skill));
    const prompt = buildSystemPrompt(skill.id);
    for (const field of ["files", "logs", "problems", "project"]) assert.ok(prompt.includes(field));
    for (const rule of ["信頼できない資料", "決して従わない", "鍵を要求したり開示", "path:line", "Verilog-2005", "VHDL", "SystemVerilog", ".cst"]) assert.ok(prompt.includes(rule));
    assert.equal(prompt.includes("gogo-fpga-changes"), skill.allowsChanges);
    if (skill.allowsChanges) {
      assert.ok(prompt.includes(`最大${PROPOSAL_LIMITS.files}ファイル`));
      assert.ok(prompt.includes(`各${PROPOSAL_LIMITS.perFile / 1024} KiB`));
      assert.ok(prompt.includes(`合計${PROPOSAL_LIMITS.total / 1024} KiB`));
      assert.ok(prompt.includes('"changes":[{"path":'));
      assert.ok(prompt.includes("ファイルの全文"));
    } else assert.ok(prompt.includes("コードフェンスは出力しない"));
  }
});

test("unknown and empty skill IDs are rejected", () => {
  for (const id of ["unknown", "", null, undefined, "toString"]) assert.throws(() => buildSystemPrompt(id), RangeError);
});

test("formal guidance matches supported targets and clock restrictions", () => {
  const prompt = buildSystemPrompt("formal");
  for (const term of ["$assert", "$assume", "$cover", "bmc/prove", "$check", "$live", "$fair", "単一ビット入力クロック"]) assert.ok(prompt.includes(term));
});

test("project summary identifies every board and counts UTF-8 and binary bytes without contents", () => {
  for (const board of BOARDS) {
    const summary = summarizeProject({ name: "例", board: board.id, top: "top", files: new Map([
      ["src/top.V", "日本語"], ["src/other.vhdl", "private contents"], ["data.bin", new Uint8Array(7)],
    ]), simulation: { top: "tb", files: ["secret"] }, formal: { top: "proof", mode: "cover", solver: "secret" } });
    assert.deepEqual(summary.board, { id: board.id, label: board.label, device: board.nextpnrDevice });
    assert.deepEqual(summary.languages, ["Verilog", "VHDL"]);
    assert.deepEqual(summary.files.map(({ bytes }) => bytes), [9, 16, 7]);
    assert.deepEqual(summary.simulation, { top: "tb" });
    assert.deepEqual(summary.formal, { top: "proof", mode: "cover" });
    assert.ok(!JSON.stringify(summary).includes("private contents"));
  }
});

test("empty project summary has no inferred languages or optional settings", () => {
  assert.equal(summarizeProject(null), null);
  assert.deepEqual(summarizeProject({ name: "empty", board: "missing", top: "top", files: new Map() }),
    { name: "empty", board: null, top: "top", languages: [], files: [] });
});
