import assert from "node:assert/strict";
import test from "node:test";
import { parseUsage, formatUsage } from "../../web/lib/ai-usage.mjs";
import { createSseParser, createChatPreview, sendChatPreview } from "../../web/lib/openrouter-chat.mjs";

const usage = { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042,
  prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } };
const stream = `data: {"choices":[{"delta":{"content":"説明"}}]}\r\n\r\ndata: ${JSON.stringify({ choices: [], usage })}\r\n\r\ndata: [DONE]\r\n\r\n`;

test("terminal usage-only SSE chunk survives every text boundary without changing text", () => {
  for (let i = 0; i <= stream.length; i++) {
    const parser = createSseParser();
    parser.push(stream.slice(0, i)); parser.push(stream.slice(i));
    assert.equal(parser.text, "説明"); assert.equal(parser.done, true);
    assert.deepEqual(parser.usage, { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042, cached_tokens: 40, reasoning_tokens: 10 });
    assert.equal(formatUsage(parser.usage), "入力 120 トークン（キャッシュ 40）・出力 30 トークン（推論 10）・費用 $0.00042");
  }
});

test("usage ignores malformed values, keeps zero and omits missing parts", () => {
  for (const value of [undefined, null, [], "usage", 0, {}, { cost: "0" }]) assert.equal(parseUsage(value), null);
  for (const value of [-1, NaN, Infinity, -Infinity, true, "3", null, [], {}]) {
    assert.deepEqual(parseUsage({ prompt_tokens: value, completion_tokens: 0, cost: value,
      prompt_tokens_details: { cached_tokens: value }, completion_tokens_details: { reasoning_tokens: value } }), { completion_tokens: 0 });
  }
  assert.equal(formatUsage(parseUsage({ cost: 0 })), "費用 $0");
  assert.equal(formatUsage(parseUsage({ prompt_tokens_details: { cached_tokens: 1 }, completion_tokens_details: { reasoning_tokens: 2 } })), "キャッシュ 1 トークン・推論 2 トークン");
  assert.equal(formatUsage(null), "使用量は返されませんでした");
  assert.equal(createSseParser().usage, null);
});

test("transport reports usage only on successful completion and preserves exact preview bytes", async () => {
  const preview = createChatPreview({ model: "x", prompt: "説明", origin: "https://example.test" });
  const body = JSON.parse(preview.body);
  assert.equal(body.usage, undefined); assert.equal(body.stream_options, undefined);
  let received;
  const answer = await sendChatPreview(preview, { key: "mock", onUsage: value => { received = value; }, fetchImpl: async (_url, options) => {
    assert.equal(options.body, preview.body);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } });
  assert.equal(answer, "説明"); assert.equal(received.cost, usage.cost);
  await assert.rejects(sendChatPreview(preview, { key: "mock", onUsage: () => assert.fail("incomplete usage"),
    fetchImpl: async () => new Response(stream.replace("data: [DONE]", ": missing"), { headers: { "content-type": "text/event-stream" } }) }), { code: "incomplete" });
});
