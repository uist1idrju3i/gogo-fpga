import { isLibraryPath } from "./libraries.mjs";
import { validatePath } from "./project.mjs";
import { AI_SKILLS, buildSystemPrompt } from "./ai-skills.mjs";
import { answerSchema } from "./ai-structured.mjs";
import { summarizeProject } from "./ai-project-summary.mjs";
import { parseUsage } from "./ai-usage.mjs";
import { gradeCommentSchema, validateRubric } from "./ai-grading.mjs";
import { TOOL_DEFINITIONS } from "./ai-read-tools.mjs";

export const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MAX_CHAT_BYTES = 2 * 1024 * 1024;
export const chatByteLength = (text) => new TextEncoder().encode(text).byteLength;
export const utf8Header = (text) => String.fromCharCode(...new TextEncoder().encode(text));
export class ChatError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function selectableFiles(files) {
  return [...files].flatMap(([path, value]) => {
    if (!validatePath(path).ok || isLibraryPath(path) || /\.(?:fs|bin)$/i.test(path)) return [];
    let content = value;
    if (content instanceof Uint8Array) {
      try { content = new TextDecoder("utf-8", { fatal: true }).decode(content); } catch { return []; }
    }
    return typeof content === "string" && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content) ? [[path, content]] : [];
  });
}

export function createChatPreview({ model, prompt, skill = "consult", hintLevel = 1, models = null, allowTools = false, project = null, history = [], resendHistory = false, files = [], logs = [], problems = [], grading = null, origin }) {
  if (typeof model !== "string" || !model.trim() || model.length > 200 ||
      typeof prompt !== "string" || !prompt.trim()) throw new ChatError("empty");
  if (new URL(origin).origin !== origin || !/^https?:/.test(origin)) throw new ChatError("preview");
  if (skill === "teach" && ![1, 2, 3].includes(hintLevel)) throw new ChatError("preview");
  if (skill === "grade") validateRubric(grading?.rubric);
  const user = JSON.stringify({ request: skill === "teach" ? `ヒントの段階: ${hintLevel}\n${prompt}` : prompt, skill, project: summarizeProject(project), files: selectableFiles(new Map(files)).map(([path, content]) => ({ path, content })), logs, problems, ...(skill === "grade" ? { grading } : {}) }, null, 2);
  const allowsChanges = AI_SKILLS.find(item => item.id === skill)?.allowsChanges;
  const supported = models?.find(item => item.id === model.trim())?.supported_parameters?.includes("structured_outputs");
  const eligible = allowsChanges || skill === "grade";
  const structured = Boolean(eligible && supported);
  const toolsEnabled = Boolean(allowTools && models?.find(item => item.id === model.trim())?.supported_parameters?.includes("tools"));
  const mode = structured ? "構造化出力を使います（変更提案または採点の講評で、取得したモデル一覧に対応の記載があります）" : `構造化出力を使いません（${!eligible ? "変更を提案しない種類です" : models === null ? "モデル一覧を取得していません" : "モデルの対応を確認できません"}）`;
  const messages = [{ role: "system", content: buildSystemPrompt(skill, { structured, toolsEnabled }) }, ...history.map(({ role, content, compact, tool_calls, tool_call_id }) => {
    if (role === "assistant" && Array.isArray(tool_calls)) return { role, content, tool_calls };
    if (role === "tool" && typeof tool_call_id === "string" && typeof content === "string") return { role, tool_call_id, content: resendHistory ? content : (compact ?? content) };
    if (!["user", "assistant"].includes(role) || typeof content !== "string") throw new ChatError("preview");
    return { role, content: role === "user" && !resendHistory ? (compact ?? content) : content };
  }), { role: "user", content: user }];
  const body = JSON.stringify({ model: model.trim(), stream: true, messages, ...(structured ? {
    response_format: { type: "json_schema", json_schema: { name: skill === "grade" ? "gogo_fpga_grade" : "gogo_fpga_answer", strict: true, schema: skill === "grade" ? gradeCommentSchema(grading.rubric) : answerSchema() } },
    provider: { require_parameters: true },
  } : {}), ...(toolsEnabled ? { tools: TOOL_DEFINITIONS, tool_choice: "auto", provider: { require_parameters: true } } : {}) }, null, 2);
  if (chatByteLength(body) > MAX_CHAT_BYTES) throw new ChatError("size");
  return Object.freeze({ url: CHAT_URL, body, bytes: chatByteLength(body),
    user, skill, structured, toolsEnabled, mode, headers: Object.freeze({ "Content-Type": "application/json", "X-OpenRouter-Title": utf8Header("午後のFPGA"), "HTTP-Referer": origin }) });
}

export function createSseParser(onDelta = () => {}) {
  let pending = "";
  let text = "";
  let done = false;
  let usage = null;
  const calls = new Map();
  let finishReason = null;
  return {
    get text() { return text; },
    get done() { return done; },
    get usage() { return usage; },
    get finishReason() { return finishReason; },
    get toolCalls() { return [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call); },
    push(chunk, final = false) {
      if (done) return;
      pending += chunk;
      if (chatByteLength(pending) > MAX_CHAT_BYTES) throw new ChatError("size");
      const lines = pending.split(/\r?\n/);
      pending = final ? "" : lines.pop();
      for (const line of lines) {
        if (done) break;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") { done = true; break; }
        let value;
        try { value = JSON.parse(data); } catch { throw new ChatError("response"); }
        if (value?.error) throw new ChatError("provider");
        if (value?.usage !== undefined) usage = parseUsage(value.usage);
        const choice = value?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (choice?.delta?.tool_calls !== undefined) {
          if (!Array.isArray(choice.delta.tool_calls)) throw new ChatError("response");
          for (const delta of choice.delta.tool_calls) {
            if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index >= 128 || delta.type !== undefined && delta.type !== "function") throw new ChatError("response");
            const call = calls.get(delta.index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
            for (const [target, source, key] of [[call, delta, "id"], [call.function, delta.function, "name"], [call.function, delta.function, "arguments"]]) {
              if (source?.[key] === undefined) continue;
              if (typeof source[key] !== "string") throw new ChatError("response");
              target[key] += source[key];
            }
            calls.set(delta.index, call);
          }
          if (chatByteLength(JSON.stringify(this.toolCalls)) > MAX_CHAT_BYTES) throw new ChatError("size");
        }
        const content = value?.choices?.[0]?.delta?.content;
        if (content === undefined || content === null) continue;
        if (typeof content !== "string") throw new ChatError("response");
        text += content;
        if (chatByteLength(text) > MAX_CHAT_BYTES) throw new ChatError("size");
        onDelta(content, text);
      }
    },
  };
}

export async function sendChatPreview(preview, { key, signal, onDelta, onToolCalls, onUsage = () => {}, fetchImpl = globalThis.fetch } = {}) {
  if (!preview || preview.url !== CHAT_URL || typeof preview.body !== "string" ||
      chatByteLength(preview.body) > MAX_CHAT_BYTES || typeof key !== "string" || !key.trim()) throw new ChatError("preview");
  let reader;
  try {
    const response = await fetchImpl(CHAT_URL, { method: "POST", body: preview.body,
      headers: { ...preview.headers, Authorization: `Bearer ${key}` },
      credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error", signal });
    if (!response.ok) throw new ChatError(({ 401: "unauthorized", 402: "credit", 429: "rate" })[response.status] ?? (response.status >= 500 ? "server" : "http"));
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) throw new ChatError("response");
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parser = createSseParser(onDelta);
    let bytes = 0;
    while (!parser.done) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) { parser.push(decoder.decode(), true); break; }
      bytes += value.byteLength;
      if (bytes > MAX_CHAT_BYTES * 4) throw new ChatError("size");
      parser.push(decoder.decode(value, { stream: true }));
    }
    signal?.throwIfAborted();
    if (!parser.done) throw new ChatError("incomplete");
    if (parser.finishReason === "tool_calls") {
      const calls = parser.toolCalls;
      if (!preview.toolsEnabled || !onToolCalls || !calls.length || calls.some(call => !call.id || !call.function.name) || new Set(calls.map(call => call.id)).size !== calls.length) throw new ChatError("response");
      onToolCalls(calls);
    } else if (parser.toolCalls.length) throw new ChatError("response");
    onUsage(parser.usage);
    return parser.text;
  } catch (error) {
    if (signal?.aborted) throw new ChatError("stopped");
    if (error instanceof ChatError) throw error;
    throw new ChatError("network");
  } finally {
    try { await reader?.cancel(); } catch { /* The response may already be aborted. */ }
    reader?.releaseLock();
  }
}
