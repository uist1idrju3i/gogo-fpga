import assert from "node:assert/strict";
import test from "node:test";
import { MODELS_URL, MAX_MODELS_BYTES, parseModels, formatModelPrice, estimatePreviewTokens, fetchModels } from "../../web/lib/openrouter-models.mjs";

const catalog = { data: [
  { id: "example/paid", context_length: 32768, pricing: { prompt: "0.0000025", completion: "0.00001" }, supported_parameters: ["tools", "reasoning", "structured_outputs"] },
  { id: "example/free", context_length: 128, pricing: { prompt: "0", completion: "-1" }, supported_parameters: [] },
] };
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json; charset=utf-8" } });

test("catalog validates metadata, preserves server order and handles empty or absent optional fields", () => {
  const models = parseModels(catalog);
  assert.deepEqual(models.map(model => model.id), ["example/paid", "example/free"]);
  assert.equal(models[0].context_length, 32768);
  assert.deepEqual(models[0].supported_parameters, ["tools", "reasoning", "structured_outputs"]);
  assert.equal(models[0].pricing.prompt, "0.0000025");
  assert.ok(Object.isFrozen(models)); assert.ok(Object.isFrozen(models[0]));
  assert.deepEqual(parseModels({ data: [] }), []);
  assert.deepEqual(parseModels({ data: [{ id: "example/minimal" }] }), [{ id: "example/minimal", context_length: null,
    pricing: { prompt: undefined, completion: undefined }, supported_parameters: null }]);
});

test("invalid root and model shapes fail closed rather than retaining a partial catalog", () => {
  for (const value of [null, [], {}, { data: {} }, { data: [null] }, { data: ["id"] }, { data: [{}] },
    { data: [{ id: "" }] }, { data: [{ id: "x y" }] }, { data: [{ id: "x" }, { id: "x" }] },
    { data: [{ id: "x", context_length: -1 }] }, { data: [{ id: "x", context_length: "20" }] },
    { data: [{ id: "x", context_length: Infinity }] }, { data: [{ id: "x", pricing: [] }] },
    { data: [{ id: "x", supported_parameters: [false] }] }, { data: Array(10001).fill({ id: "x" }) }]) {
    assert.throws(() => parseModels(value), { code: "invalid" });
  }
});

test("pricing strings convert per token to per million without sorting or treating invalid prices as free", () => {
  for (const value of ["-1", "-0.01", "", " ", "NaN", "Infinity", "1e309", "1e-999", "3x", "0x10", "1,000", "1e308", 0, null, undefined, {}, []]) assert.equal(formatModelPrice(value), "不明");
  for (const value of ["0", "0.000", "0e-9"]) assert.equal(formatModelPrice(value), "無料");
  assert.equal(formatModelPrice("0.0000025"), "$2.5");
  assert.equal(formatModelPrice("0.00001"), "$10");
  assert.equal(formatModelPrice("1e-7"), "$0.1");
  assert.equal(formatModelPrice(".00000001"), "$0.01");
});

test("token heuristic includes JSON structure and UTF-8 bytes rather than dividing Japanese text by four", () => {
  assert.equal(estimatePreviewTokens(""), 0);
  assert.equal(estimatePreviewTokens("abcd"), 4);
  assert.equal(estimatePreviewTokens("相談"), 6);
  const body = JSON.stringify({ prompt: "説明してください" });
  assert.equal(estimatePreviewTokens(body), Buffer.byteLength(body));
});

test("public catalog fetch is keyless, hardened and validates HTTP and JSON errors", async () => {
  assert.equal((await fetchModels({ fetchImpl: async (url, options) => {
    assert.equal(url, MODELS_URL);
    assert.deepEqual(options, { method: "GET", credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    return jsonResponse(catalog);
  } })).length, 2);
  for (const fetchImpl of [async () => new Response("denied", { status: 403 }), async () => new Response("{}"),
    async () => jsonResponse({ nope: [] }), async () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    async () => { throw new Error("private diagnostic"); },
    async () => new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } })]) {
    await assert.rejects(fetchModels({ fetchImpl }), error => ["response", "invalid"].includes(error.code) && !error.message.includes("private"));
  }
});

test("catalog enforces byte cap from both headers and streamed bytes, cancels readers and accepts exact limit", async () => {
  let reads = 0, cancelled = 0;
  const response = headers => new Response(new ReadableStream({ pull(controller) {
    reads++; controller.enqueue(new Uint8Array(MAX_MODELS_BYTES + 1));
  }, cancel() { cancelled++; } }), { headers: { "content-type": "application/json", ...headers } });
  await assert.rejects(fetchModels({ fetchImpl: async () => response({}) }), { code: "size" });
  assert.ok(cancelled > 0); assert.ok(reads <= 2);
  await assert.rejects(fetchModels({ fetchImpl: async () => response({ "content-length": String(MAX_MODELS_BYTES + 1) }) }), { code: "size" });
  assert.equal(cancelled, 2);
  const body = '{"data":[]}' + " ".repeat(MAX_MODELS_BYTES - 11);
  assert.equal(Buffer.byteLength(body), MAX_MODELS_BYTES);
  assert.deepEqual(await fetchModels({ fetchImpl: async () => new Response(body, { headers: { "content-type": "application/json" } }) }), []);
});
