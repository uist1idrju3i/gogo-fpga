import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { sbyCases } from "../tests/synth/formal-sby-cases.mjs";
import { satFormalCases } from "../tests/synth/formal-sat-cases.mjs";
import { smtVhdlReplayCases } from "../tests/synth/formal-smt-vhdl-replay-cases.mjs";
import { classifySbyStatus } from "../web/lib/formal-sby-status.mjs";
import { cpus, totalmem, release } from "node:os";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { out: { type: "string" }, web: { type: "string", default: "public_html" },
  repeats: { type: "string", default: "5" }, scope: { type: "string", default: "sby" } } });
assert.ok(values.out, "Use --out NEW_DIRECTORY [--web WEB_ROOT] [--repeats COUNT]");
assert.ok(["sby", "all"].includes(values.scope), "Scope must be sby or all");
const repeats = Number(values.repeats);
assert.ok(Number.isInteger(repeats) && repeats >= 5 && repeats <= 20, "At least five repetitions are required");
const out = path.resolve(values.out);
assert.ok(!existsSync(out), "Refusing to overwrite qualification evidence");
mkdirSync(out, { recursive: true });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (name, value) => writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + "\n");
const snapshots = {};
for (const name of ["scripts/qualify-yices-product.mjs", "tests/product/formal.test.mjs", "tests/synth/formal-sby-cases.mjs",
  "tests/synth/formal-sat-cases.mjs", "tests/synth/formal-smt-vhdl-replay-cases.mjs", "tests/web/sim-node-worker.mjs",
  "tests/synth/formal-python-helpers.mjs", "scripts/build-formal-solvers.py", "scripts/build-solver-probe.py",
  "web/ide.mjs", "web/lib/formal-runner.mjs", "web/lib/formal-simulator.mjs", "web/lib/formal-assets.mjs",
  "web/lib/formal-properties.mjs", "web/lib/formal-tool-command.mjs", "web/lib/formal-tool-process.mjs",
  "web/lib/formal-wasi-job.mjs", "web/lib/sim-runner.mjs", "web/sim-worker.js", "package-lock.json"]) {
  snapshots[name] = digest(readFileSync(path.join(root, name)));
}
save("metadata.json", { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), command: process.argv.slice(1),
  snapshots, node: process.version, host: { release: release(), cpus: cpus().length, memoryBytes: totalmem() },
  scope: values.scope, repeats, execution: "Node worker_threads; browser and hardware are not tested" });
const rows = [];
const columns = ["trial", "case", "mode", "expected", "actual", "kind", "elapsed_ms", "solver_sha256", "log_sha256", "error",
  ...(values.scope === "all" ? ["language", "replay", "ghdl_sha256", "libraries_sha256"] : [])];
const cases = sbyCases.map(fixture => ({ ...fixture, file: `sby-${fixture.name}`, key: "outcome", language: "Verilog" }));
if (values.scope === "all") {
  cases.push(...satFormalCases.map(fixture => ({ ...fixture, file: fixture.name, key: "outcome", name: `sat-${fixture.name}`,
    mode: fixture.mode ?? "bmc", status: fixture.expected === "error" ? "sat-error" : fixture.expected, language: "Verilog",
    kind: ({ "bounded-safe": "bounded-pass", "counterexample": "counterexample", proved: "proved", "inconsistent-assumptions": "unknown" })[fixture.expected] ?? "tool-error" })),
  ...smtVhdlReplayCases.map(fixture => ({ ...fixture, file: `vhdl-${fixture.name}`, key: "outcome", name: `vhdl-${fixture.name}`,
    status: fixture.name === "no-property" ? "invalid-properties" : fixture.status, language: "VHDL",
    kind: fixture.name === "no-property" ? "tool-error" : classifySbyStatus(fixture.mode, fixture.status) })));
  for (const [file, results] of [
    ["lifecycle-sat", { cancelled: ["cancelled", "cancelled"], timedOut: ["timeout", "timeout"], restarted: ["bounded-safe", "bounded-pass"] }],
    ["lifecycle-sby", { cancelled: ["cancelled", "cancelled"], restarted: ["PASS", "bounded-pass"] }],
    ["vhdl-negative-controls", { corrupt: ["ghdl-error", "tool-error"], syntax: ["ghdl-error", "tool-error"],
      sat: ["counterexample", "counterexample"], mixed: ["unsupported-input", "tool-error"] }],
  ]) for (const [key, [status, kind]] of Object.entries(results)) {
    cases.push({ file, key, name: `${file}-${key}`, status, kind, mode: "bmc", language: file.startsWith("vhdl") ? "VHDL" : "Verilog" });
  }
}
const csv = () => writeFileSync(path.join(out, "results.csv"), [columns, ...rows.map(row => columns.map(name => row[name] ?? ""))]
  .map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n");
let failed = false;
for (let trial = 1; trial <= repeats; trial++) {
  const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "tests/product/formal.test.mjs"], {
    cwd: root, env: { ...process.env, FORMAL_WEB_ROOT: values.web }, encoding: "utf8", timeout: 660_000, maxBuffer: 16 * 1024 * 1024,
  });
  const log = run.stdout + run.stderr;
  writeFileSync(path.join(out, `trial-${trial}.log`), log);
  const evidence = /^Formal product evidence: (.+)$/m.exec(log)?.[1];
  if (run.status !== 0 || !evidence) failed = true;
  const identity = evidence && existsSync(path.join(evidence, "yices2-identity.json"))
    ? JSON.parse(readFileSync(path.join(evidence, "yices2-identity.json"))) : null;
  for (const fixture of cases) {
    const resultPath = evidence && path.join(evidence, `${fixture.file}.json`);
    const result = resultPath && existsSync(resultPath) ? JSON.parse(readFileSync(resultPath)) : null;
    const outcome = result?.[fixture.key];
    const row = { trial, case: fixture.name, mode: fixture.mode, expected: fixture.status, actual: outcome?.status,
      kind: outcome?.kind, elapsed_ms: outcome?.elapsedMs, solver_sha256: identity?.sha256, log_sha256: digest(log),
      language: fixture.language, replay: outcome?.replay?.status, ghdl_sha256: result?.ghdlSha256, libraries_sha256: result?.librariesSha256,
      error: run.status !== 0 ? `test exit ${run.status}: ${run.error?.message ?? "see trial log"}` : "" };
    if (row.actual !== row.expected || row.kind !== fixture.kind || !identity ||
        (outcome?.kind === "counterexample" && row.replay !== (fixture.language === "VHDL" ? "unavailable" : "verified"))) {
      row.error ||= "Missing or unexpected result"; failed = true;
    }
    rows.push(row);
  }
  save(`trial-${trial}.json`, { status: run.status, evidence: evidence ? path.relative(root, evidence) : null, identity });
  csv();
  console.log(`trial ${trial}/${repeats}: ${run.status === 0 ? "passed" : "failed"}`);
}
if (failed) process.exitCode = 1;
