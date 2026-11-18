import { PROPOSAL_LIMITS, parseProposals, validateProposals } from "./ai-proposals.mjs";
import { parseGradeComments } from "./ai-grading.mjs";

export function parseAiAnswer(text, { skill, structured, user }, files) {
  if (skill === "grade") {
    let rubric;
    try { rubric = JSON.parse(user).grading.rubric; } catch { /* Invalid context is rejected by the parser. */ }
    const grade = parseGradeComments(text, { structured, rubric });
    return { answer: grade.error ? text : "講評を採点の項目に表示しました。点数は端末で計算したものです。", grade, proposals: { valid: [], rejected: [] } };
  }
  if (skill === "teach") return { answer: text, proposals: { valid: [], rejected: [] } };
  return structured ? parseStructuredAnswer(text, files) : { answer: text, proposals: parseProposals(text, files) };
}

export function answerSchema() {
  return { type: "object", properties: {
    answer: { type: "string" },
    changes: { type: "array", maxItems: PROPOSAL_LIMITS.files, items: {
      type: "object", properties: { path: { type: "string" }, reason: { type: "string" },
        content: { type: ["string", "null"] },
        edits: { type: ["array", "null"], minItems: 1, items: {
          type: "object", properties: { search: { type: "string", minLength: 1 }, replace: { type: "string" } },
          required: ["search", "replace"], additionalProperties: false,
        } },
      },
      required: ["path", "reason", "content", "edits"], additionalProperties: false,
    } },
  }, required: ["answer", "changes"], additionalProperties: false };
}

export function parseStructuredAnswer(text, files) {
  const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  try {
    const value = JSON.parse(text);
    if (!exactKeys(value, ["answer", "changes"]) || typeof value.answer !== "string" || !Array.isArray(value.changes) ||
        !value.changes.every(change => exactKeys(change, ["path", "reason", "content", "edits"]) &&
          [change.path, change.reason].every(field => typeof field === "string") &&
          (change.content === null || typeof change.content === "string") &&
          (change.edits === null || Array.isArray(change.edits) && change.edits.every(edit =>
            exactKeys(edit, ["search", "replace"]) && typeof edit.search === "string" && typeof edit.replace === "string")))) throw new Error();
    return { answer: value.answer, proposals: validateProposals(value.changes, files) };
  } catch {
    return { answer: text, proposals: { valid: [], rejected: [{ path: "", reason: "提案の JSON を確認できません。本文だけを表示します。" }] } };
  }
}
