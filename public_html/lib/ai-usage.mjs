export function parseUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = {};
  for (const [key, number] of Object.entries({
    prompt_tokens: value.prompt_tokens,
    completion_tokens: value.completion_tokens,
    cost: value.cost,
    cached_tokens: value.prompt_tokens_details?.cached_tokens,
    reasoning_tokens: value.completion_tokens_details?.reasoning_tokens,
  })) {
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) usage[key] = number;
  }
  return Object.keys(usage).length ? Object.freeze(usage) : null;
}

export function formatUsage(usage) {
  if (!usage) return "使用量は返されませんでした";
  const parts = [];
  if (usage.prompt_tokens !== undefined) parts.push(`入力 ${usage.prompt_tokens} トークン${usage.cached_tokens !== undefined ? `（キャッシュ ${usage.cached_tokens}）` : ""}`);
  else if (usage.cached_tokens !== undefined) parts.push(`キャッシュ ${usage.cached_tokens} トークン`);
  if (usage.completion_tokens !== undefined) parts.push(`出力 ${usage.completion_tokens} トークン${usage.reasoning_tokens !== undefined ? `（推論 ${usage.reasoning_tokens}）` : ""}`);
  else if (usage.reasoning_tokens !== undefined) parts.push(`推論 ${usage.reasoning_tokens} トークン`);
  if (usage.cost !== undefined) parts.push(`費用 $${usage.cost}`);
  return parts.join("・");
}
