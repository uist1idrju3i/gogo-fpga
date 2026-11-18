export const GRADING_LIMITS = Object.freeze({ criteria: 20, points: 1000, id: 64, title: 200, comment: 2000, rubricBytes: 16384 });

const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const textWithin = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function validateRubric(value) {
  if (!exactKeys(value, ["version", "criteria"]) || value.version !== 1 || !Array.isArray(value.criteria) ||
      value.criteria.length < 1 || value.criteria.length > GRADING_LIMITS.criteria) throw new Error("rubric");
  const ids = new Set();
  let total = 0;
  for (const criterion of value.criteria) {
    if (!exactKeys(criterion, ["id", "title", "points", "check"]) || !textWithin(criterion.id, GRADING_LIMITS.id) ||
        !textWithin(criterion.title, GRADING_LIMITS.title) || ids.has(criterion.id) ||
        !["simulation", "formal", "comment"].includes(criterion.check) || !Number.isInteger(criterion.points) ||
        (criterion.check === "comment" ? criterion.points !== 0 : criterion.points < 1)) throw new Error("rubric");
    ids.add(criterion.id); total += criterion.points;
  }
  if (total > GRADING_LIMITS.points) throw new Error("rubric");
  return { version: 1, criteria: value.criteria.map(criterion => ({ ...criterion })) };
}

export function defaultRubric() {
  return { version: 1, criteria: [
    { id: "simulation", title: "シミュレーションの合格", points: 50, check: "simulation" },
    { id: "formal", title: "形式検証の合格", points: 50, check: "formal" },
    { id: "design", title: "設計への講評", points: 0, check: "comment" },
  ] };
}

export function loadRubric(files) {
  if (!files.has("rubric.json")) return { rubric: defaultRubric(), isDefault: true };
  try {
    const content = files.get("rubric.json");
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    if (!(bytes instanceof Uint8Array) || bytes.length > GRADING_LIMITS.rubricBytes) throw new Error("rubric");
    return { rubric: validateRubric(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), isDefault: false };
  } catch {
    return { error: "rubric.json の形式を確認してください。採点できません。項目のキー、重複、文字数、配点の上限を確認してください。" };
  }
}

export function scoreRubric(rubric, results = {}, state) {
  const checked = validateRubric(rubric);
  const criteria = checked.criteria.map(criterion => {
    const result = results[criterion.check];
    let status, reason;
    if (criterion.check === "comment") { status = "講評のみ"; reason = "点数には含めません。"; }
    else if (!result) { status = "未実行"; reason = "この端末ではまだ実行していません。"; }
    else if (!state || result.state !== state) { status = "未実行"; reason = "ファイルまたは検証設定が変わりました。再実行してください。"; }
    else if (result.outcome === "not-run") { status = "未実行"; reason = result.reason; }
    else { status = result.outcome === "ok" ? "合格" : "不合格"; reason = result.reason; }
    return { ...criterion, status, reason, score: status === "合格" ? criterion.points : 0 };
  });
  return { rubric: checked, criteria, total: criteria.reduce((sum, item) => sum + item.score, 0), maximum: criteria.reduce((sum, item) => sum + item.points, 0) };
}

export function gradeCommentSchema(rubric) {
  const ids = validateRubric(rubric).criteria.map(({ id }) => id);
  return { type: "object", properties: { comments: { type: "array", maxItems: ids.length, items: {
    type: "object", properties: { id: { type: "string", enum: ids }, comment: { type: "string", minLength: 1, maxLength: GRADING_LIMITS.comment } },
    required: ["id", "comment"], additionalProperties: false,
  } } }, required: ["comments"], additionalProperties: false };
}

export function parseGradeComments(text, { structured = false, rubric } = {}) {
  try {
    const ids = new Set(validateRubric(rubric).criteria.map(({ id }) => id));
    const fences = structured ? null : [...text.matchAll(/^```gogo-fpga-grade\s*\r?\n([\s\S]*?)^```[ \t]*$/gm)];
    if (!structured && fences.length !== 1) throw new Error("comments");
    const body = JSON.parse(structured ? text : fences[0][1]);
    if (!exactKeys(body, ["comments"]) || !Array.isArray(body.comments) || body.comments.length > ids.size) throw new Error("comments");
    const seen = new Set();
    for (const item of body.comments) {
      if (!exactKeys(item, ["id", "comment"]) || !ids.has(item.id) || seen.has(item.id) || !textWithin(item.comment, GRADING_LIMITS.comment)) throw new Error("comments");
      seen.add(item.id);
    }
    return { comments: body.comments, error: null };
  } catch {
    return { comments: [], error: "講評を項目に結び付けられませんでした。応答の本文を表示します。点数は端末での採点結果のままです。" };
  }
}
