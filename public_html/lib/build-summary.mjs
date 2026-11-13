import { parseToolDiagnostics } from "./tool-diagnostics.mjs";

export function parseBuildSummary(logs) {
  const resources = new Map();
  const clocks = new Map();
  let warnings = null;
  for (const [tool, text] of logs) {
    const clean = String(text).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    if (clean.trim()) warnings = (warnings ?? 0) + parseToolDiagnostics(tool, clean).filter(({ severity }) => severity === "warning").length;
    if (tool !== "nextpnr") continue;
    for (const line of clean.split(/\r?\n/)) {
      const resource = line.match(/^\s*(?:Info:\s*)?([A-Za-z][A-Za-z0-9_]*):\s+(\d+)\s*\/\s*(\d+)\s+\d+%\s*$/);
      if (resource) {
        const used = Number(resource[2]);
        const available = Number(resource[3]);
        if (Number.isSafeInteger(used) && Number.isSafeInteger(available) && available > 0 && used <= available) {
          resources.set(resource[1], { name: resource[1], used, available });
        }
      }
      const clock = line.match(/Max frequency for clock '([^']+)':\s*([\d.]+)\s+MHz/);
      if (clock && Number.isFinite(Number(clock[2])) && Number(clock[2]) > 0) clocks.set(clock[1], { name: clock[1], mhz: Number(clock[2]) });
    }
  }
  return { resources: [...resources.values()], clocks: [...clocks.values()], warnings };
}
