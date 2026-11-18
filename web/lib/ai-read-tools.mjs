import { validatePath } from "./project.mjs";
import { PROPOSAL_LIMITS } from "./ai-proposals.mjs";
import { selectableFiles, chatByteLength, MAX_CHAT_BYTES, ChatError } from "./openrouter-chat.mjs";

export const READ_TOOL_LIMITS = Object.freeze({ calls: 4, rounds: 3, get bytes() { return PROPOSAL_LIMITS.perFile; } });
export const TOOL_REFUSAL = "利用者がこの読み取り結果の送信を拒否しました。";
export const TOOL_DEFINITIONS = [
  { type: "function", function: { name: "list_files", description: "プロジェクトのパスとバイト数だけを一覧にします。内容は含めません。", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
  { type: "function", function: { name: "read_file", description: "プロジェクト内のテキストを読みます。結果は利用者が確認し、送信を許可した場合だけ返ります。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } } },
];
const exactKeys = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

export function capToolResult(text) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= READ_TOOL_LIMITS.bytes) return text;
  const note = "\n（容量の上限に達したため、残りを省略しました。）";
  let end = READ_TOOL_LIMITS.bytes - chatByteLength(note);
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end)) + note;
}

export function readToolResult(call, files) {
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { return "引数の JSON が不正なため読み取りません。"; }
  if (call.function.name === "list_files") {
    if (!exactKeys(args, [])) return "引数のキーが不正なため一覧を返しません。";
    return capToolResult(JSON.stringify([...files].map(([path, value]) => ({ path, bytes: typeof value === "string" ? chatByteLength(value) : value.byteLength })), null, 2));
  }
  if (call.function.name !== "read_file") return "未知のツールのため読み取りを拒否しました。";
  if (!exactKeys(args, ["path"]) || !validatePath(args.path).ok || !files.has(args.path)) return "プロジェクトにある正確な相対パスだけを指定してください。";
  const content = new Map(selectableFiles(new Map([[args.path, files.get(args.path)]]))).get(args.path);
  return content === undefined ? "バイナリーまたは選択できないファイルの読み取りは拒否しました。" : capToolResult(content);
}

export function captureToolWorkspace({ projectId, files }) {
  return { projectId, files: new Map([...files].map(([path, value]) => [path, typeof value === "string" ? value : value.slice()])) };
}
export function sameToolWorkspace(captured, current) {
  return captured?.projectId === current?.projectId && captured.files.size === current.files.size && [...captured.files].every(([path, value]) => {
    const next = current.files.get(path);
    return typeof value === "string" ? next === value : next instanceof Uint8Array && value.length === next.length && value.every((byte, i) => byte === next[i]);
  });
}

export function toolResultPreview(selected, calls, results) {
  if (calls.length !== results.length || !selected.toolsEnabled || (selected.toolRound ?? 0) >= READ_TOOL_LIMITS.rounds) throw new ChatError("preview");
  const assistant = { role: "assistant", content: null, tool_calls: calls };
  const messages = [assistant, ...calls.map((call, index) => ({ role: "tool", tool_call_id: call.id, content: index >= READ_TOOL_LIMITS.calls ? TOOL_REFUSAL : results[index] }))];
  if (messages.some(message => message.role === "tool" && typeof message.content !== "string")) throw new ChatError("preview");
  const payload = JSON.parse(selected.body), toolRound = (selected.toolRound ?? 0) + 1;
  payload.messages.push(...messages);
  if (toolRound >= READ_TOOL_LIMITS.rounds) { delete payload.tools; delete payload.tool_choice; }
  const body = JSON.stringify(payload, null, 2);
  if (chatByteLength(body) > MAX_CHAT_BYTES) throw new ChatError("size");
  return Object.freeze({ ...selected, body, bytes: chatByteLength(body), toolRound, toolsEnabled: toolRound < READ_TOOL_LIMITS.rounds,
    mode: toolRound >= READ_TOOL_LIMITS.rounds ? "読み取りの往復の上限に達したため、次はツールを付けずに送信します。" : selected.mode,
    turnMessages: [...(selected.turnMessages ?? [{ role: "user", content: selected.user }]), ...messages] });
}
