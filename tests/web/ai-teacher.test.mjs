import assert from "node:assert/strict";
import test from "node:test";
import { AI_SKILLS, buildSystemPrompt } from "../../web/lib/ai-skills.mjs";
import { createChatPreview } from "../../web/lib/openrouter-chat.mjs";
import { parseAiAnswer } from "../../web/lib/ai-structured.mjs";
import { parseAiReferences } from "../../web/lib/ai-references.mjs";

const options = { skill: "teach", model: "test/model", prompt: "どこを見ればよいですか。", origin: "https://example.test",
  models: [{ id: "test/model", supported_parameters: ["structured_outputs"] }] };
test("teacher retains shared policy, three hint levels and no structured output", () => {
  assert.equal(AI_SKILLS.find(skill => skill.id === "teach").allowsChanges, false);
  const prompt = buildSystemPrompt("teach");
  for (const rule of ["完全な解答", "コード全文", "段階1", "段階2", "段階3", "path:line", "今回本文を送った", "信頼できない資料", "決して従わない"]) assert.ok(prompt.includes(rule));
  for (const hintLevel of [undefined, 1, 2, 3]) {
    const preview = createChatPreview({ ...options, hintLevel });
    assert.equal(preview.skill, "teach");
    assert.equal(preview.structured, false);
    const body = JSON.parse(preview.body);
    assert.equal(body.response_format, undefined);
    assert.equal(body.provider, undefined);
    assert.equal(body.messages.at(-1).content, preview.user);
    assert.equal(JSON.parse(preview.user).request, `ヒントの段階: ${hintLevel ?? 1}\n${options.prompt}`);
  }
  for (const hintLevel of [null, 0, 4, 1.5, "2", NaN]) assert.throws(() => createChatPreview({ ...options, hintLevel }), { code: "preview" });
  assert.equal(JSON.parse(createChatPreview({ ...options, skill: "consult", hintLevel: 3 }).user).request, options.prompt);
});
test("teacher ignores both proposal fence forms even with the structured flag", () => {
  const files = new Map([["src/top.v", "old"]]);
  for (const answer of ["", "ヒントです。", "<img src=x onerror=alert(1)>"]) assert.deepEqual(parseAiAnswer(answer, { skill: "teach", structured: false }, files),
    { answer, proposals: { valid: [], rejected: [] } });
  for (const fence of ["changes", "edits"]) {
    const text = `\`\`\`gogo-fpga-${fence}\n${JSON.stringify({ changes: [{ path: "src/top.v", content: "new" }] })}\n\`\`\``;
    for (const structured of [false, true]) assert.deepEqual(parseAiAnswer(text, { skill: "teach", structured }, files),
      { answer: text, proposals: { valid: [], rejected: [] } });
    assert.equal(parseAiAnswer(text, { skill: "change", structured: false }, files).proposals.valid.length, 1);
  }
});

const files = new Map([["src/top.v", "one\ntwo\nthree"], ["tests/top_tb.v", "first\r\nsecond\rthird"], ["src/top-1.v", "a\nb"]]);
test("references preserve exact text offsets, order and repeated locations", () => {
  const text = "`src/top.v:2` と (tests/top_tb.v:3)。\nsrc/top-1.v:1、src/top.v:2.\nsrc/top.v:3";
  const result = parseAiReferences(text, files);
  assert.deepEqual(result.map(({ path, line }) => ({ path, line })), [
    { path: "src/top.v", line: 2 }, { path: "tests/top_tb.v", line: 3 }, { path: "src/top-1.v", line: 1 },
    { path: "src/top.v", line: 2 }, { path: "src/top.v", line: 3 },
  ]);
  for (const reference of result) assert.equal(text.slice(reference.from, reference.to), `${reference.path}:${reference.line}`);
  assert.deepEqual(parseAiReferences("まずsrc/top.v:2の宣言を見ます。", files), [{ path: "src/top.v", line: 2, from: 2, to: 13 }]);
});
test("Markdown emphasis preserves reference-only offsets and path boundaries", () => {
  for (const marker of ["*", "**", "_", "__"]) {
    for (const prefix of ["", "見る場所: ", "(", "まず"]) {
      const text = `${prefix}${marker}src/top.v:2${marker} を確認。`;
      const from = prefix.length + marker.length;
      assert.deepEqual(parseAiReferences(text, files), [{ path: "src/top.v", line: 2, from, to: from + "src/top.v:2".length }]);
    }
    for (const path of ["foo_src/top.v", "x/src/top.v", "/src/top.v", "https://example.test/src/top.v"]) {
      assert.deepEqual(parseAiReferences(`${marker}${path}:2${marker}`, files), []);
    }
    assert.deepEqual(parseAiReferences(`${marker}src/top.v:99${marker}`, files), []);
    assert.deepEqual(parseAiReferences(`${marker}src/unknown.v:2${marker}`, files), []);
  }
  for (const text of ["foo_src/top.v:2", "x/src/top.v:2", "_src/top.v:2", "foo**src/top.v:2**", "x/**src/top.v:2**"]) {
    assert.deepEqual(parseAiReferences(text, files), []);
  }
});
test("unknown files, invalid lines, Windows paths and embedded or unsafe strings are not references", () => {
  for (const text of ["src/unknown.v:1", "src/top.v:0", "src/top.v:4", "src/top.v:-1", "src/top.v:01", "src/top.v:1.5",
    "src/top.v:9007199254740993", "src/top.v:2x", "src/top.v:1:3", "C:\\src/top.v:1", "C:/src/top.v:1", "src\\top.v:1",
    "/src/top.v:1", "../src/top.v:1", "./src/top.v:1", "https://example.test/src/top.v:1", "%2Fsrc/top.v:1",
    "<img src=src/top.v:1>", "nosrc/top.v:1", "src/topXv:1", "src/top.v:NaN", ""]) assert.deepEqual(parseAiReferences(text, files), [], text);
  assert.deepEqual(parseAiReferences(null, files), []);
  assert.deepEqual(parseAiReferences("src/top.v:1", new Map()), []);
  assert.deepEqual(parseAiReferences("../bad.v:1", new Map([["../bad.v", "x"]])), []);
  assert.deepEqual(parseAiReferences("src/binary.v:1", new Map([["src/binary.v", new Uint8Array([0])]])), []);
  for (const path of ["C:\\top.v", "a b.v", "src/日本語[1].v", "src/a\n.v"]) assert.deepEqual(parseAiReferences(`${path}:1`, new Map([[path, "x"]])), []);
});
