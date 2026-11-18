import { PROPOSAL_LIMITS, validateProposals } from "./ai-proposals.mjs";

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
