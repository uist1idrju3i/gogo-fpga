import { createTwoFilesPatch } from "diff";
import { validatePath } from "./project.mjs";
import { isLibraryPath } from "./libraries.mjs";
import { chatByteLength, selectableFiles } from "./openrouter-chat.mjs";

export const PROPOSAL_LIMITS = Object.freeze({ files: 8, perFile: 128 * 1024, total: 512 * 1024 });
const rejected = (path, reason) => ({ path: typeof path === "string" ? path : "（パスなし）", reason });
export function validateProposals(changes, files) {
  if (!Array.isArray(changes) || changes.length > PROPOSAL_LIMITS.files) return { valid: [], rejected: [rejected("", "提案は最大8ファイルです。形式と件数を確認してください。")] };
  const counts = new Map();
  for (const change of changes) counts.set(change?.path, (counts.get(change?.path) ?? 0) + 1);
  if (changes.reduce((n, c) => n + (typeof c?.content === "string" ? chatByteLength(c.content) : 0), 0) > PROPOSAL_LIMITS.total) {
    return { valid: [], rejected: [rejected("", "提案全体が512 KiBを超えています。")] };
  }
  const valid = [], errors = [];
  const editable = new Map(selectableFiles(files));
  for (const change of changes) {
    const path = change?.path;
    let reason;
    if (typeof path !== "string" || !validatePath(path).ok || /[\x00-\x1f\x7f]/.test(path)) reason = "正規化されたプロジェクト内の相対パスではありません。";
    else if (isLibraryPath(path)) reason = "ライブラリーファイルは変更できません。";
    else if (/\.cst$/i.test(path)) reason = ".cst は生成されるため変更できません。ボードのピン設定を使ってください。";
    else if (counts.get(path) > 1) reason = "同じパスが重複しています。";
    else if ([...files.keys(), ...counts.keys()].some((other) => typeof other === "string" && other !== path && (path.startsWith(`${other}/`) || other.startsWith(`${path}/`)))) reason = "ファイルとディレクトリーのパスが衝突しています。";
    else if (typeof change.content !== "string" || chatByteLength(change.content) > PROPOSAL_LIMITS.perFile) reason = "内容は128 KiB以内の文字列にしてください。";
    else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(change.content) || /\.(?:fs|bin)$/i.test(path) || files.has(path) && !editable.has(path)) reason = "バイナリーファイルは変更できません。";
    else if (!files.has(path) && !/^(?:src|tests)\/.+\.(?:v|vh|sv|vhd|vhdl)$/.test(path)) reason = "新しい HDL ファイルは src/ または tests/ に作成してください。";
    if (reason) errors.push(rejected(path, reason));
    else valid.push(Object.freeze({ path, content: change.content, reason: typeof change.reason === "string" ? change.reason.slice(0, 2000) : "" }));
  }
  return { valid, rejected: errors };
}

export function parseProposals(text, files) {
  const blocks = [...text.matchAll(/^```gogo-fpga-changes[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```[^\S\r\n]*$/gm)];
  if (!blocks.length) return { valid: [], rejected: [] };
  try {
    if (blocks.length !== 1) throw new Error();
    const body = JSON.parse(blocks[0][1]);
    return validateProposals(body?.changes, files);
  } catch { return { valid: [], rejected: [rejected("", "提案の JSON を確認できません。本文だけを表示します。")] }; }
}

export function proposalDiff(change, files) {
  return createTwoFilesPatch(change.path, change.path, files.get(change.path) ?? "", change.content, "送信時", "提案", { context: 3, timeout: 1000, maxEditLength: 20000 });
}
async function digest(value) {
  if (value === undefined) return null;
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function proposalSnapshot(workspace) {
  const files = new Map(workspace.files);
  return { projectId: workspace.projectId, files, hashes: new Map(await Promise.all([...files].map(async ([p, c]) => [p, await digest(c)]))) };
}
export class ProposalError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function createProposalEditor({ getWorkspace, isBusy, saveRevision }) {
  let undo;
  let applying = false;
  async function check(snapshot, paths) {
    if (isBusy()) throw new ProposalError("busy");
    const current = getWorkspace();
    if (current.projectId !== snapshot.projectId) throw new ProposalError("changed");
    for (const path of paths) {
      if ((snapshot.hashes.get(path) ?? null) !== await digest(current.files.get(path))) throw new ProposalError("changed");
    }
    if (getWorkspace().revision !== current.revision || getWorkspace().projectId !== current.projectId || isBusy()) throw new ProposalError("changed");
    return current;
  }
  return {
    get canUndo() { return Boolean(undo); },
    async apply(changes, snapshot) {
      if (!changes.length) throw new ProposalError("empty");
      if (applying) throw new ProposalError("busy");
      applying = true;
      try {
        const current = await check(snapshot, changes.map((c) => c.path));
        const validation = validateProposals(changes, current.files);
        if (validation.rejected.length) throw new ProposalError("invalid");
        const files = new Map(current.files);
        const before = new Map();
        for (const change of validation.valid) { before.set(change.path, files.get(change.path)); files.set(change.path, change.content); }
        const next = { ...current, files, project: { ...current.project, files: [...files.keys()].map((path) => ({ path })) } };
        const after = await proposalSnapshot(next);
        await saveRevision(next, current);
        undo = { before, after };
      } finally { applying = false; }
    },
    async undo() {
      if (!undo) throw new ProposalError("empty");
      if (applying) throw new ProposalError("busy");
      applying = true;
      try {
        const current = await check(undo.after, [...undo.before.keys()]);
        const files = new Map(current.files);
        for (const [path, content] of undo.before) { if (content === undefined) files.delete(path); else files.set(path, content); }
        await saveRevision({ ...current, files, project: { ...current.project, files: [...files.keys()].map((path) => ({ path })) } }, current);
        undo = undefined;
      } finally { applying = false; }
    },
  };
}
