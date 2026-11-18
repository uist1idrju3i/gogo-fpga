import assert from "node:assert/strict";
import test from "node:test";
import { defaultRubric, validateRubric, loadRubric, scoreRubric, gradeCommentSchema, parseGradeComments, GRADING_LIMITS } from "../../web/lib/ai-grading.mjs";
import { AI_SKILLS, buildSystemPrompt } from "../../web/lib/ai-skills.mjs";
import { createChatPreview } from "../../web/lib/openrouter-chat.mjs";
import { parseAiAnswer } from "../../web/lib/ai-structured.mjs";

const machine = (outcome, state = "current") => ({ outcome, state, reason: "検査の結果" });
const comments = [{ id: "design", comment: "入力の前提を説明してください。" }];
const fence = value => `\`\`\`gogo-fpga-grade\n${JSON.stringify(value)}\n\`\`\``;

test("rubric validates exact machine and unscored criteria and returns independent defaults", () => {
  const loaded = loadRubric(new Map());
  assert.equal(loaded.isDefault, true);
  assert.deepEqual(loaded.rubric.criteria.map(({ check, points }) => [check, points]), [["simulation", 50], ["formal", 50], ["comment", 0]]);
  const checked = validateRubric(loaded.rubric);
  checked.criteria[0].title = "別の題";
  assert.notEqual(checked.criteria[0].title, loaded.rubric.criteria[0].title);
  loaded.rubric.criteria.pop();
  assert.equal(defaultRubric().criteria.length, 3);
  const present = loadRubric(new Map([["rubric.json", new TextEncoder().encode(JSON.stringify(defaultRubric()))]]));
  assert.equal(present.isDefault, false);
  assert.deepEqual(present.rubric, defaultRubric());
});

for (const [name, change] of [
  ["duplicate IDs", value => value.criteria.push({ ...value.criteria[0] })],
  ["extra root key", value => value.score = 100],
  ["extra criterion key", value => value.criteria[0].score = 50],
  ["missing key", value => delete value.criteria[0].title],
  ["wrong version", value => value.version = 2],
  ["empty criteria", value => value.criteria = []],
  ["too many criteria", value => value.criteria = Array.from({ length: 21 }, (_, i) => ({ ...value.criteria[0], id: String(i) }))],
  ["too many points", value => value.criteria[0].points = 1000],
  ["fractional points", value => value.criteria[0].points = 1.5],
  ["zero machine points", value => value.criteria[0].points = 0],
  ["negative points", value => value.criteria[0].points = -1],
  ["scored comment", value => value.criteria[2].points = 1],
  ["unknown check", value => value.criteria[0].check = "build"],
  ["empty ID", value => value.criteria[0].id = " "],
  ["long ID", value => value.criteria[0].id = "a".repeat(GRADING_LIMITS.id + 1)],
  ["long title", value => value.criteria[0].title = "a".repeat(GRADING_LIMITS.title + 1)],
]) test(`rubric rejects ${name} without falling back to defaults`, () => {
  const value = defaultRubric(); change(value);
  assert.throws(() => validateRubric(value));
  const result = loadRubric(new Map([["rubric.json", JSON.stringify(value)]]));
  assert.match(result.error, /採点できません/);
  assert.equal(result.rubric, undefined);
});

test("malformed, oversized and non-UTF-8 rubric files fail closed; 1000 points is accepted", () => {
  for (const content of ["", "null", "{", " ".repeat(GRADING_LIMITS.rubricBytes + 1), new Uint8Array([255])]) {
    assert.ok(loadRubric(new Map([["rubric.json", content]])).error);
  }
  const value = defaultRubric(); value.criteria[0].points = 950;
  assert.equal(validateRubric(value).criteria[0].points, 950);
});

test("machine passes receive full points and comment criteria are never scored", () => {
  const result = scoreRubric(defaultRubric(), { simulation: machine("ok"), formal: machine("ok") }, "current");
  assert.equal(result.total, 100); assert.equal(result.maximum, 100);
  assert.deepEqual(result.criteria.map(item => [item.status, item.score]), [["合格", 50], ["合格", 50], ["講評のみ", 0]]);
});

test("all failures, timeouts and unknown outcomes receive zero", () => {
  for (const outcome of ["failed", "timeout", "stopped", "unknown", "running", undefined]) {
    const result = scoreRubric(defaultRubric(), { simulation: machine(outcome), formal: machine(outcome) }, "current");
    assert.equal(result.total, 0);
    assert.equal(result.criteria[0].status, "不合格");
  }
});

test("not-run and stale results show Japanese reasons and score zero", () => {
  const none = scoreRubric(defaultRubric(), {}, "current");
  assert.equal(none.criteria[0].status, "未実行"); assert.match(none.criteria[0].reason, /まだ実行/);
  const stale = scoreRubric(defaultRubric(), { simulation: machine("ok", "old"), formal: machine("not-run") }, "current");
  assert.equal(stale.total, 0);
  assert.deepEqual(stale.criteria.slice(0, 2).map(item => item.status), ["未実行", "未実行"]);
  assert.match(stale.criteria[0].reason, /変わりました/);
  assert.equal(scoreRubric(defaultRubric(), { simulation: machine("ok") }).total, 0);
});

test("structured and fenced comments accept known unique IDs and empty lists", () => {
  for (const list of [comments, []]) {
    const value = { comments: list };
    assert.deepEqual(parseGradeComments(JSON.stringify(value), { structured: true, rubric: defaultRubric() }), { comments: list, error: null });
    assert.deepEqual(parseGradeComments(fence(value), { rubric: defaultRubric() }), { comments: list, error: null });
  }
  const schema = gradeCommentSchema(defaultRubric());
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.comments.items.additionalProperties, false);
  assert.deepEqual(schema.properties.comments.items.properties.id.enum, ["simulation", "formal", "design"]);
});

test("comment parser rejects unknown/duplicate IDs, extra score/points, missing and long comments", () => {
  for (const value of [
    { comments: [{ id: "unknown", comment: "講評" }] }, { comments: [comments[0], comments[0]] },
    { comments, score: 1000 }, { comments, points: 1000 },
    { comments: [{ ...comments[0], score: 100 }] }, { comments: [{ ...comments[0], points: 100 }] },
    { comments: [{ id: "design" }] }, { comments: [{ id: "design", comment: "" }] },
    { comments: [{ id: "design", comment: "x".repeat(GRADING_LIMITS.comment + 1) }] },
    { comments: null }, null, [],
  ]) for (const structured of [false, true]) {
    const result = parseGradeComments(structured ? JSON.stringify(value) : fence(value), { structured, rubric: defaultRubric() });
    assert.deepEqual(result.comments, []); assert.match(result.error, /結び付けられません/);
  }
  for (const text of ["plain", "{}", fence({ comments }) + "\n" + fence({ comments })]) assert.ok(parseGradeComments(text, { rubric: defaultRubric() }).error);
});

test("grade previews gate schemas on fetched metadata, include local scoring and never produce proposals", () => {
  const grading = scoreRubric(defaultRubric(), { simulation: machine("ok") }, "current");
  assert.equal(AI_SKILLS.find(item => item.id === "grade").allowsChanges, false);
  assert.match(buildSystemPrompt("grade"), /gogo-fpga-grade/);
  assert.match(buildSystemPrompt("grade", { structured: true }), /JSON Schema/);
  for (const models of [null, [{ id: "model", supported_parameters: [] }], [{ id: "model", supported_parameters: ["structured_outputs"] }]]) {
    const preview = createChatPreview({ model: "model", prompt: "講評してください。", skill: "grade", grading, models, origin: "http://localhost" });
    assert.deepEqual(JSON.parse(preview.user).grading, grading);
    const body = JSON.parse(preview.body);
    assert.equal(preview.structured, models?.[0].supported_parameters.includes("structured_outputs") ?? false);
    if (preview.structured) { assert.equal(body.provider.require_parameters, true); assert.deepEqual(body.response_format.json_schema.schema, gradeCommentSchema(defaultRubric())); }
    else assert.equal(body.response_format, undefined);
    for (const response of [fence({ comments }), JSON.stringify({ comments }), '```gogo-fpga-changes\n{"changes":[{"path":"src/x.v","content":"module x; endmodule"}]}\n```', '```gogo-fpga-edits\n{"changes":[]}\n```']) {
      assert.deepEqual(parseAiAnswer(response, preview, new Map()).proposals, { valid: [], rejected: [] });
    }
    const good = parseAiAnswer(preview.structured ? JSON.stringify({ comments }) : fence({ comments }), preview, new Map());
    assert.deepEqual(good.grade.comments, comments);
    const bad = parseAiAnswer("model score: 999", preview, new Map());
    assert.equal(bad.answer, "model score: 999"); assert.ok(bad.grade.error);
  }
});
