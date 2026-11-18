import { test } from "node:test";
import assert from "node:assert/strict";
import { answerSchema, parseStructuredAnswer } from "../../web/lib/ai-structured.mjs";
import { PROPOSAL_LIMITS } from "../../web/lib/ai-proposals.mjs";
import { createChatPreview } from "../../web/lib/openrouter-chat.mjs";
import { buildSystemPrompt } from "../../web/lib/ai-skills.mjs";

const options = { model: "example/model", prompt: "提案してください", skill: "change", origin: "https://example.test" };
const models = [{ id: options.model, supported_parameters: ["structured_outputs"] }];
const change = { path: "src/top.v", content: "module top; endmodule", reason: "理由" };
test("strict schema requires every field and rejects additional properties", () => {
  const schema = answerSchema();
  assert.deepEqual(schema.required, ["answer", "changes"]);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.changes.maxItems, PROPOSAL_LIMITS.files);
  assert.deepEqual(schema.properties.changes.items.required, ["path", "content", "reason"]);
  assert.equal(schema.properties.changes.items.additionalProperties, false);
});
test("only fetched supporting models and change skills enable structured streaming", () => {
  const preview = createChatPreview({ ...options, models });
  const body = JSON.parse(preview.body);
  assert.equal(body.stream, true);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.deepEqual(body.response_format, { type: "json_schema", json_schema: { name: "gogo_fpga_answer", strict: true, schema: answerSchema() } });
  assert.match(body.messages[0].content, /answer.*changes/);
  assert.doesNotMatch(body.messages[0].content, /gogo-fpga-changes/);
  assert.equal(preview.structured, true);
  for (const extra of [{}, { models: [] }, { models: [{ id: options.model, supported_parameters: [] }] },
    { models: [{ id: "other", supported_parameters: ["structured_outputs"] }] }, { models, skill: "consult" }, { models, skill: "review" }]) {
    const fallback = createChatPreview({ ...options, ...extra });
    const value = JSON.parse(fallback.body);
    assert.equal(value.response_format, undefined);
    assert.equal(value.provider, undefined);
    assert.equal(fallback.structured, false);
    assert.equal(value.messages[0].content, buildSystemPrompt(extra.skill ?? options.skill));
  }
});
test("structured responses validate proposals, including empty changes and unsafe paths", () => {
  const files = new Map();
  assert.deepEqual(parseStructuredAnswer(JSON.stringify({ answer: "説明", changes: [change] }), files),
    { answer: "説明", proposals: { valid: [change], rejected: [] } });
  assert.deepEqual(parseStructuredAnswer('{"answer":"説明","changes":[]}', files), { answer: "説明", proposals: { valid: [], rejected: [] } });
  for (const changes of [[{ ...change, path: "../x.v" }], Array(PROPOSAL_LIMITS.files + 1).fill(change), [{ ...change, content: "x".repeat(PROPOSAL_LIMITS.perFile + 1) }]]) {
    const result = parseStructuredAnswer(JSON.stringify({ answer: "説明", changes }), files);
    assert.equal(result.proposals.valid.length, 0);
    assert.ok(result.proposals.rejected.length);
  }
});
test("malformed, missing, wrong-type and extra fields retain raw text with no applicable proposals", () => {
  for (const value of [null, [], {}, { answer: 1, changes: [] }, { answer: "a", changes: {} },
    { answer: "a", changes: [], extra: 1 }, { answer: "a", changes: [{ ...change, extra: true }] },
    { answer: "a", changes: [{ path: "src/x.v", content: "x" }] }, { answer: "a", changes: [{ ...change, reason: 1 }] }]) {
    const text = JSON.stringify(value);
    const result = parseStructuredAnswer(text, new Map());
    assert.equal(result.answer, text);
    assert.equal(result.proposals.valid.length, 0);
    assert.match(result.proposals.rejected[0].reason, /JSON/);
  }
  assert.equal(parseStructuredAnswer("{", new Map()).answer, "{");
});
