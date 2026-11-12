import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_URL, createChatPreview, createSseParser, sendChatPreview, selectableFiles, utf8Header } from "../../web/lib/openrouter-chat.mjs";

const token = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
const data = `: OPENROUTER PROCESSING\r\n\r\n${token("午後")}${token("のFPGA")}data: [DONE]\r\n\r\n`;
const preview = () => createChatPreview({ model: "openrouter/auto", prompt: "説明してください", origin: "https://example.test", files: [["src/top.v", "module top; endmodule"]] });
function response(bytes, headers = { "content-type": "text/event-stream" }) {
  return new Response(new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(b); c.close(); } }), { headers });
}

test("SSE parses comments, CRLF, DONE, metadata and every text chunk boundary", () => {
  for (let i = 0; i <= data.length; i++) {
    const updates = [];
    const parser = createSseParser((delta) => updates.push(delta));
    parser.push(data.slice(0, i)); parser.push(data.slice(i));
    assert.equal(parser.text, "午後のFPGA"); assert.equal(parser.done, true);
    assert.equal(updates.join(""), parser.text);
    parser.push(token("ignored")); assert.equal(parser.text, "午後のFPGA");
  }
  const parser = createSseParser();
  parser.push('data: {"choices":[{"delta":{"role":"assistant"}}]}\n');
  parser.push("data: [DONE]", true); assert.equal(parser.done, true);
});

test("transport preserves preview bytes and handles multibyte UTF-8 split at every byte", async () => {
  const p = preview();
  let sent;
  const bytes = new TextEncoder().encode(data);
  const result = await sendChatPreview(p, { key: "test-key", fetchImpl: async (url, options) => {
    assert.equal(url, CHAT_URL); sent = options;
    return response([...bytes].map((b) => Uint8Array.of(b)));
  } });
  assert.equal(result, "午後のFPGA");
  assert.deepEqual(new TextEncoder().encode(sent.body), new TextEncoder().encode(p.body));
  assert.equal(sent.headers.Authorization, "Bearer test-key");
  assert.equal(sent.headers["HTTP-Referer"], "https://example.test");
  assert.equal(new TextDecoder().decode(Uint8Array.from(utf8Header("午後のFPGA"), (c) => c.charCodeAt(0))), "午後のFPGA");
  assert.doesNotThrow(() => new Headers(sent.headers));
  assert.equal(sent.redirect, "error"); assert.equal(sent.credentials, "omit");
  assert.equal(sent.referrerPolicy, "no-referrer"); assert.equal(sent.cache, "no-store");
  assert.equal(p.bytes, new TextEncoder().encode(p.body).length);
  assert.ok(Object.isFrozen(p)); assert.ok(Object.isFrozen(p.headers));
});

test("context excludes libraries, binary extensions/values, malformed paths and control bytes", () => {
  const files = new Map([["src/top.v", "module top; endmodule"], ["libraries/a/sources/x.v", "library"], ["build/top.fs", "binary"], ["src/bin.v", new Uint8Array([0])], ["src/nul.v", "a\0"], ["../secret.v", "secret"]]);
  assert.deepEqual(selectableFiles(files).map(([p]) => p), ["src/top.v"]);
  const p = createChatPreview({ model: "x", prompt: "help", files: [...files], history: [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }], origin: "https://example.test" });
  const parsed = JSON.parse(p.body);
  assert.equal(parsed.messages.length, 4);
  assert.deepEqual(JSON.parse(parsed.messages[3].content).files.map((f) => f.path), ["src/top.v"]);
  for (const prompt of ["", " "]) assert.throws(() => createChatPreview({ model: "x", prompt, origin: "https://example.test" }));
});

test("transport sanitizes HTTP, provider, malformed, incomplete and network errors", async () => {
  for (const [status, code] of [[401, "unauthorized"], [402, "credit"], [429, "rate"], [500, "server"], [403, "http"]]) {
    await assert.rejects(sendChatPreview(preview(), { key: "secret", fetchImpl: async () => new Response("secret", { status }) }), { message: code });
  }
  for (const [body, code] of [['data: {"error":{"message":"secret"}}\n', "provider"], ["data: garbage\n", "response"], [token("partial"), "incomplete"], ["", "incomplete"]]) {
    await assert.rejects(sendChatPreview(preview(), { key: "secret", fetchImpl: async () => response([new TextEncoder().encode(body)]) }), { message: code });
  }
  await assert.rejects(sendChatPreview(preview(), { key: "secret", fetchImpl: async () => { throw new Error("secret"); } }), { message: "network" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sendChatPreview(preview(), { key: "secret", signal: controller.signal, fetchImpl: async () => response([]) }), { message: "stopped" });
});
