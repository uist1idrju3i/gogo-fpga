import assert from "node:assert/strict";
import test from "node:test";
import { readToolResult, capToolResult, TOOL_REFUSAL, READ_TOOL_LIMITS, toolResultPreview, captureToolWorkspace, sameToolWorkspace } from "../../web/lib/ai-read-tools.mjs";
import { createChatPreview, createSseParser, sendChatPreview, chatByteLength } from "../../web/lib/openrouter-chat.mjs";
import { compactToolResult } from "../../web/lib/ai-history.mjs";
const files = new Map([["src/top.v", "module top; endmodule"], ["日本語.bin", new Uint8Array([255])], ["text.txt", new TextEncoder().encode("資料")], ["bad.txt", new Uint8Array([0])]]);
const call = (name = "read_file", args = { path: "src/top.v" }, id = "call_1") => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const options = { model: "model", prompt: "相談", origin: "http://localhost" };
const models = [{ id: "model", supported_parameters: ["tools", "structured_outputs"] }];
const event = choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
test("list_files returns paths and UTF-8 byte sizes without content; read_file returns selectable text", () => {
  assert.deepEqual(JSON.parse(readToolResult(call("list_files", {}), files)), [...files].map(([path, value]) => ({ path, bytes: typeof value === "string" ? chatByteLength(value) : value.length })));
  assert.equal(readToolResult(call(), files), files.get("src/top.v"));
  assert.equal(readToolResult(call("read_file", { path: "text.txt" }), files), "資料");
});
test("tools refuse unknown names, binary/non-selectable files and non-exact args/paths", () => {
  for (const args of [null, [], {}, { path: "missing" }, { path: "../src/top.v" }, { path: "src/./top.v" }, { path: "/src/top.v" }, { path: "src/top.v", extra: 1 }]) assert.match(readToolResult(call("read_file", args), files), /正確/);
  for (const args of [{ path: "src/top.v" }, [], null]) assert.match(readToolResult(call("list_files", args), files), /不正/);
  for (const path of ["image.fs", "image.bin", "bad.txt", "library/x.v"]) assert.match(readToolResult(call("read_file", { path }), new Map([...files, [path, new Uint8Array([0])]])), /拒否/);
  assert.match(readToolResult(call("write_file", {}), files), /未知/);
  assert.match(readToolResult({ function: { name: "read_file", arguments: "{" } }, files), /不正/);
});
test("tool output cap preserves UTF-8 and explicitly notes truncation", () => {
  const capped = capToolResult("あ".repeat(READ_TOOL_LIMITS.bytes));
  assert.ok(chatByteLength(capped) <= READ_TOOL_LIMITS.bytes);
  assert.ok(!capped.includes("\ufffd")); assert.match(capped, /省略/);
  assert.equal(capToolResult(""), "");
});
test("tools are opt-in and metadata gated; unoffered request bodies stay identical", () => {
  const original = createChatPreview(options).body;
  for (const params of [{ allowTools: true }, { models }, { allowTools: true, models: [{ id: "model", supported_parameters: [] }] }]) assert.equal(createChatPreview({ ...options, ...params }).body, original);
  const body = JSON.parse(createChatPreview({ ...options, models, allowTools: true }).body);
  assert.deepEqual(body.tools.map(item => item.function.name), ["list_files", "read_file"]);
  assert.equal(body.tool_choice, "auto"); assert.equal(body.provider.require_parameters, true);
  const structured = JSON.parse(createChatPreview({ ...options, models, allowTools: true, skill: "change" }).body);
  assert.ok(structured.response_format); assert.equal(structured.provider.require_parameters, true);
});
test("stream parser accumulates split parallel call arguments by index", () => {
  const parser = createSseParser();
  const sse = event({ delta: { tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "list_files", arguments: "{" } }, { index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"src/' } }] } }) +
    event({ delta: { tool_calls: [{ index: 0, function: { arguments: 'top.v"}' } }, { index: 1, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }) + "data: [DONE]\n\n";
  for (const char of sse) parser.push(char);
  assert.deepEqual(parser.toolCalls, [call("read_file", { path: "src/top.v" }, "a"), call("list_files", {}, "b")]);
  assert.equal(parser.finishReason, "tool_calls"); assert.equal(parser.done, true);
  assert.throws(() => createSseParser().push(event({ delta: { tool_calls: [{ index: -1 }] } })));
});
test("completed call streams require opt-in and cannot execute anything by themselves", async () => {
  const text = event({ delta: { tool_calls: [{ index: 0, ...call() }] }, finish_reason: "tool_calls" }) + "data: [DONE]\n\n";
  const fetchImpl = async () => new Response(text, { headers: { "content-type": "text/event-stream" } });
  let calls;
  await sendChatPreview(createChatPreview({ ...options, allowTools: true, models }), { key: "test", fetchImpl, onToolCalls: value => { calls = value; } });
  assert.deepEqual(calls, [call()]);
  await assert.rejects(sendChatPreview(createChatPreview(options), { key: "test", fetchImpl, onToolCalls: () => {} }), { code: "response" });
});
test("continuation preserves messages, refuses extra calls and removes tools after three rounds", () => {
  const calls = Array.from({ length: 5 }, (_, index) => call("list_files", {}, String(index)));
  let preview = createChatPreview({ ...options, models, allowTools: true });
  for (let round = 1; round <= READ_TOOL_LIMITS.rounds; round++) {
    preview = toolResultPreview(preview, calls, calls.map(() => "結果"));
    const body = JSON.parse(preview.body);
    assert.deepEqual(body.messages.at(-6), { role: "assistant", content: null, tool_calls: calls });
    assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "4", content: TOOL_REFUSAL });
    assert.equal(preview.bytes, chatByteLength(preview.body));
    assert.equal(Boolean(body.tools), round < READ_TOOL_LIMITS.rounds);
  }
  assert.throws(() => toolResultPreview(preview, calls, calls.map(() => "結果")));
});
test("tool results compact to SHA-256 and UTF-8 bytes on later turns, with explicit full resend", async () => {
  const compact = await compactToolResult("資料");
  assert.equal(JSON.parse(compact).bytes, 6); assert.match(JSON.parse(compact).sha256, /^[a-f0-9]{64}$/);
  const history = [{ role: "assistant", content: null, tool_calls: [call()] }, { role: "tool", tool_call_id: "call_1", content: "資料", compact }];
  for (const resendHistory of [false, true]) {
    const body = JSON.parse(createChatPreview({ ...options, history, resendHistory }).body);
    assert.equal(body.messages[2].content, resendHistory ? "資料" : compact);
    assert.deepEqual(body.messages[1].tool_calls, [call()]);
  }
});
test("workspace confirmation detects changes, additions, removals and project switches", () => {
  const workspace = { projectId: "project", files: new Map(files) }, captured = captureToolWorkspace(workspace);
  assert.equal(sameToolWorkspace(captured, workspace), true);
  for (const next of [{ ...workspace, projectId: "other" }, { ...workspace, files: new Map() }, { ...workspace, files: new Map([...files, ["src/top.v", "new"]]) }]) assert.equal(sameToolWorkspace(captured, next), false);
  workspace.files.get("bad.txt")[0] = 1;
  assert.equal(sameToolWorkspace(captured, workspace), false);
});
