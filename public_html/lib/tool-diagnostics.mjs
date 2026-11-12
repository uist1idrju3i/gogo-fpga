const locationPattern = /^((?:\/?work\/)?[^:]+\.(?:v|vh|sv|vhd|vhdl|cst)):(\d+)(?::(\d+))?:\s*(.*)$/i;

export function parseToolDiagnostics(tool, text) {
  if (!["ghdl", "yosys", "nextpnr", "gowin_pack", "ivlpp", "ivl", "vvp"].includes(tool)) {
    throw new TypeError(`Unsupported diagnostic tool: ${tool}`);
  }
  const diagnostics = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
    if (!line) continue;
    const location = line.match(locationPattern);
    const file = location?.[1].replace(/^\/?work\//, "");
    const severity = /\b(?:warning|warn)\b/i.test(line)
      ? "warning"
      : /\b(?:info|note)\b/i.test(line)
        ? "info"
        : "error";
    if (location) {
      diagnostics.push({
        file,
        line: Number(location[2]),
        ...(location[3] ? { column: Number(location[3]) } : {}),
        severity,
        message: location[4],
      });
    } else if (
      /\b(?:\w*error|failed|exception|traceback)\b/i.test(line) ||
      (tool === "gowin_pack" && /\b(?:invalid|cannot|could not)\b/i.test(line))
    ) {
      diagnostics.push({ file: null, severity, message: line });
    }
  }
  return diagnostics;
}
