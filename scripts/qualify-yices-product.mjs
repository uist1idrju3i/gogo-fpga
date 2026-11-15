import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sbyCases } from "../tests/synth/formal-sby-cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string" }, web: { type: "string", default: "public_html" },
  repeats: { type: "string", default: "5" } } });
assert.ok(values.out, "Use --out NEW_DIRECTORY [--web WEB_ROOT] [--repeats COUNT]");
const repeats = Number(values.repeats);
assert.ok(Number.isInteger(repeats) && repeats >= 5 && repeats <= 20, "At least five repetitions are required");
const out = path.resolve(values.out);
assert.ok(!existsSync(out), "Refusing to overwrite qualification evidence");
mkdirSync(out, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
const snapshots = {};
for (const name of ["scripts/qualify-yices-product.mjs", "tests/product/formal.test.mjs", "tests/synth/formal-sby-cases.mjs",
  "scripts/build-formal-solvers.py", "scripts/build-solver-probe.py", "web/lib/formal-runner.mjs", "package-lock.json"]) {
  snapshots[name] = digest(readFileSync(path.join(root, name)));
}
save("metadata.json", { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), command: process.argv.slice(1),
  snapshots, node: process.version, repeats, execution: "Node worker_threads; browser and hardware are not tested" });
const rows = [];
const columns = ["trial", "case", "mode", "expected", "actual", "kind", "elapsed_ms", "solver_sha256", "log_sha256", "error"];
const csv = () => writeFileSync(path.join(out, "results.csv"), [columns, ...rows.map(row => columns.map(name => row[name] ?? ""))]
  .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n");
let failed = false;
for (let trial = 1; trial <= repeats; trial++) {
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/product/formal.test.mjs"], {
    cwd: root, env: { ...process.env, FORMAL_WEB_ROOT: values.web }, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024,
  });
  const log = run.stdout + run.stderr;
  writeFileSync(path.join(out, `trial-${trial}.log`), log);
  const evidence = /^Formal product evidence: (.+)$/m.exec(log)?.[1];
  if (run.status !== 0 || !evidence) failed = true;
  const identity = evidence && existsSync(path.join(evidence, "yices2-identity.json"))
    ? JSON.parse(readFileSync(path.join(evidence, "yices2-identity.json"))) : null;
  for (const fixture of sbyCases) {
    const resultPath = evidence && path.join(evidence, `sby-${fixture.name}.json`);
    const result = resultPath && existsSync(resultPath) ? JSON.parse(readFileSync(resultPath)) : null;
    const row = { trial, case: fixture.name, mode: fixture.mode, expected: fixture.status, actual: result?.outcome?.status,
      kind: result?.outcome?.kind, elapsed_ms: result?.elapsedMs, solver_sha256: identity?.sha256, log_sha256: digest(log),
      error: run.status !== 0 ? `test exit ${run.status}: ${run.error?.message ?? "see trial log"}` : "" };
    if (row.actual !== row.expected || row.kind !== fixture.kind || !identity) { row.error ||= "Missing or unexpected result"; failed = true; }
    rows.push(row);
  }
  save(`trial-${trial}.json`, { status: run.status, evidence: evidence ? path.relative(root, evidence) : null, identity });
  csv();
  console.log(`trial ${trial}/${repeats}: ${run.status === 0 ? "passed" : "failed"}`);
}
if (failed) process.exitCode = 1;
