import { validatePath } from "./project.mjs";

export function parseAiReferences(text, files) {
  if (typeof text !== "string" || !(files instanceof Map)) return [];
  const references = [];
  for (const [path, content] of files) {
    if (typeof path !== "string" || !validatePath(path).ok || /[\x00-\x1f\x7f\\]/.test(path) || typeof content !== "string") continue;
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp('(^|[\\s(\\[{"\'`]|[^\\x00-\\x7f])(' + escaped + '):([1-9][0-9]*)(?=$|[\\s)\\]}"\'`!?;,]|[^\\x00-\\x7f]|\\.(?![\\w/]))', "gm");
    const lines = content.split(/\r\n?|\n/).length;
    for (const match of text.matchAll(pattern)) {
      const line = Number(match[3]);
      if (!Number.isSafeInteger(line) || line > lines) continue;
      const from = match.index + match[1].length;
      references.push({ path, line, from, to: match.index + match[0].length });
    }
  }
  const sorted = references.sort((a, b) => a.from - b.from || b.to - a.to);
  let end = 0;
  return sorted.filter(reference => {
    if (reference.from < end) return false;
    end = reference.to;
    return true;
  });
}
