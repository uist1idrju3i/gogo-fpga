import { PROPOSAL_LIMITS, validateProposals } from "./ai-proposals.mjs";

export function answerSchema() {
  return { type: "object", properties: {
    answer: { type: "string" },
    changes: { type: "array", maxItems: PROPOSAL_LIMITS.files, items: {
      type: "object", properties: { path: { type: "string" }, content: { type: "string" }, reason: { type: "string" } },
      required: ["path", "content", "reason"], additionalProperties: false,
    } },
  }, required: ["answer", "changes"], additionalProperties: false };
}

export function parseStructuredAnswer(text, files) {
  const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  try {
    const value = JSON.parse(text);
    if (!exactKeys(value, ["answer", "changes"]) || typeof value.answer !== "string" || !Array.isArray(value.changes) ||
        !value.changes.every(change => exactKeys(change, ["path", "content", "reason"]) &&
          [change.path, change.content, change.reason].every(field => typeof field === "string"))) throw new Error();
    return { answer: value.answer, proposals: validateProposals(value.changes, files) };
  } catch {
    return { answer: text, proposals: { valid: [], rejected: [{ path: "", reason: "提案の JSON を確認できません。本文だけを表示します。" }] } };
  }
}
