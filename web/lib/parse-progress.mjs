const PROGRESS = /(?:\]\s*|:\s*)(\d{1,3}(?:\.\d+)?)\s*%/g;

export function parseProgress(chunk) {
  if (typeof chunk !== "string") {
    return null;
  }

  let latest = null;
  for (const match of chunk.matchAll(PROGRESS)) {
    latest = Number(match[1]);
  }
  if (latest === null || !Number.isFinite(latest)) {
    return null;
  }
  return Math.min(100, Math.max(0, latest));
}
