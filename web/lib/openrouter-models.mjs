export const MODELS_URL = "https://openrouter.ai/api/v1/models";
export const MAX_MODELS_BYTES = 3 * 1024 * 1024;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);

export class ModelsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function parseModels(value) {
  if (!record(value) || !Array.isArray(value.data) || value.data.length > 10000) throw new ModelsError("invalid");
  const ids = new Set();
  return Object.freeze(value.data.map(model => {
    if (!record(model) || typeof model.id !== "string" || !model.id || model.id.length > 200 ||
        /\s|[\x00-\x1f\x7f]/.test(model.id) || ids.has(model.id) ||
        (model.context_length !== undefined && (!Number.isSafeInteger(model.context_length) || model.context_length <= 0)) ||
        (model.pricing !== undefined && !record(model.pricing)) ||
        (model.supported_parameters !== undefined && (!Array.isArray(model.supported_parameters) ||
          !model.supported_parameters.every(parameter => typeof parameter === "string")))) throw new ModelsError("invalid");
    ids.add(model.id);
    return Object.freeze({ id: model.id, context_length: model.context_length ?? null,
      pricing: Object.freeze({ prompt: model.pricing?.prompt, completion: model.pricing?.completion }),
      supported_parameters: model.supported_parameters ? Object.freeze([...model.supported_parameters]) : null });
  }));
}

export function formatModelPrice(value) {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return "不明";
  const number = Number(value), perMillion = number * 1000000;
  if (!Number.isFinite(perMillion) || (number === 0 && /[1-9]/.test(value.split(/[eE]/)[0]))) return "不明";
  return number === 0 ? "無料" : `$${Number(perMillion.toPrecision(15))}`;
}

export function estimatePreviewTokens(body) {
  // UTF-8 の1バイトを1トークンと数え、本文の構造と日本語も多めに見積もる。実際の分割はモデルによって異なる。
  return new TextEncoder().encode(body).byteLength;
}

export async function fetchModels({ fetchImpl = globalThis.fetch } = {}) {
  let reader;
  try {
    const response = await fetchImpl(MODELS_URL, { method: "GET", credentials: "omit",
      referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) throw new ModelsError("response");
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_MODELS_BYTES) {
      await response.body.cancel();
      throw new ModelsError("size");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MODELS_BYTES) throw new ModelsError("size");
      text += decoder.decode(value, { stream: true });
    }
    return parseModels(JSON.parse(text + decoder.decode()));
  } catch (error) {
    if (error instanceof ModelsError) throw error;
    throw new ModelsError("response");
  } finally {
    try { await reader?.cancel(); } catch { /* 既に閉じている応答もある。 */ }
    reader?.releaseLock();
  }
}
