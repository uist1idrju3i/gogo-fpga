const codes = { PASS: 0, FAIL: 2, UNKNOWN: 4, ERROR: 16, TIMEOUT: 8, CANCELLED: 32 };

export function classifySbyStatus(mode, status) {
  const kinds = {
    bmc: { PASS: "bounded-pass", FAIL: "counterexample" },
    prove: { PASS: "proved", FAIL: "counterexample" },
    cover: { PASS: "covered", FAIL: "unreached" },
  };
  if (!Object.hasOwn(kinds, mode)) throw new Error("Unsupported SBY mode");
  if (!Object.hasOwn(codes, status)) throw new Error("Unsupported SBY status");
  return kinds[mode][status] ?? { UNKNOWN: "unknown", ERROR: "tool-error", TIMEOUT: "timeout", CANCELLED: "cancelled" }[status];
}

export function readSbyStatus(text, exitCode, stdout) {
  const match = /^(PASS|FAIL|UNKNOWN|ERROR|TIMEOUT|CANCELLED) (\d+) (\d+(?:\.\d+)?)\n$/.exec(text);
  if (!match || match[0] !== text) throw new Error("Missing or malformed upstream SBY status");
  const [, status, code, elapsed] = match;
  if (Number(code) !== codes[status]) throw new Error("Unexpected SBY status/return-code pair");
  if (exitCode !== codes[status]) throw new Error("Process exit disagrees with SBY status");
  if (!stdout.includes(`DONE (${status}, rc=${code})`)) throw new Error("Missing SBY termination line");
  if (!Number.isFinite(Number(elapsed))) throw new Error("Malformed SBY elapsed time");
  return status;
}
