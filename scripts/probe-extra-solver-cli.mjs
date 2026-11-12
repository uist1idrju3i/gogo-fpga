import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { root, digest, loadSolverProbe } from "../tests/synth/solver-protocol-helpers.mjs";
import { startSolverProcess } from "../web/lib/solver-process.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";

globalThis.crossOriginIsolated = true;

const { values } = parseArgs({ options: {
  native: { type: "string" }, wasi: { type: "string" }, out: { type: "string" },
  solver: { type: "string", default: "boolector" }, "negative-wasi": { type: "string" },
  phase: { type: "string", default: "preliminary" },
} });
assert.ok(values.native && values.wasi && values.out, "Required: --native --wasi --out");
assert.ok(["boolector", "bitwuzla"].includes(values.solver), "Unsupported solver");
assert.ok(["preliminary", "formal-probe"].includes(values.phase), "Unsupported measurement phase");
const worktree = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
if (values.phase === "formal-probe") {
  assert.equal(values.solver, "bitwuzla");
  assert.equal(worktree, "", "Formal CLI measurements require a clean worktree");
  assert.ok(values["negative-wasi"], "Formal CLI measurements require the pre-fix negative control");
}
const probes = [loadSolverProbe(values.native, values.solver, "native"), loadSolverProbe(values.wasi, values.solver, "wasi")];
assert.equal(probes[0].info.base_commit, probes[1].info.base_commit);
const negative = values["negative-wasi"] ? loadSolverProbe(values["negative-wasi"], values.solver, "wasi") : null;
if (negative) {
  assert.equal(values.solver, "bitwuzla");
  assert.ok(!negative.info.patches.some(patch => patch.path === "patches/bitwuzla-wasi-exit.patch"));
  assert.ok(probes[1].info.patches.some(patch => patch.path === "patches/bitwuzla-wasi-exit.patch"));
}
const output = path.resolve(values.out);
mkdirSync(output);
const json = (file, value) => writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const csv = fields => fields.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",") + "\n";
const columns = ["runtime", "case", "status", "exit_code", "signal", "elapsed_ms", "wasm_memory_bytes",
  "input_sha256", "stdout_sha256", "stderr_sha256", "binary_sha256", "build_commit", "metadata_sha256", "write_error"];
const results = path.join(output, "results.csv");
writeFileSync(results, csv(columns), { flag: "wx" });
const solverArgs = values.solver === "boolector" ? ["--smt2", "-i"] : ["--lang=smt2"];
const satExit = values.solver === "boolector" ? 10 : 0;
const cases = [
  { name: "version", args: ["--version"], input: "", exit: 0 },
  { name: "help", args: ["--help"], input: "", exit: 0 },
  { name: "values-push-pop", args: solverArgs, exit: satExit,
    input: "(set-option :produce-models true)(set-logic QF_BV)(declare-fun x () (_ BitVec 8))(assert (= x #x2a))(check-sat)(get-value (x))(push 1)(assert (= x #x2b))(check-sat)(pop 1)(check-sat)\n",
    stdout: "sat\n((x #b00101010))\nunsat\nsat\n" },
  { name: "eof", args: solverArgs, input: "(set-logic QF_BV)(check-sat)\n", exit: satExit, stdout: "sat\n" },
  { name: "syntax", args: solverArgs, input: "(set-logic QF_BV)(not-a-command)\n", exit: 1 },
];
if (values.solver === "bitwuzla") {
  cases.push({ name: "model", args: solverArgs, exit: 0,
    input: "(set-option :produce-models true)(set-logic QF_BV)(declare-fun x () (_ BitVec 8))(assert (= x #x2a))(check-sat)(get-model)\n",
    stdout: "sat\n(\n  (define-fun x () (_ BitVec 8) #b00101010)\n)\n" });
  cases.push({ name: "time-limit-boundary", args: [...solverArgs, "--time-limit=10000"], exit: 0,
    input: "(set-logic QF_BV)(check-sat)\n", stdout: "sat\n",
    wasi: { status: "runtime-error", exit: null, stdout: "", stderr: "Bitwuzla: threaded CLI time limits are unavailable on WASI\n" } });
  for (const [mode, expected] of [["RNE", "#x3f800000"], ["RNA", "#x3f800001"], ["RTP", "#x3f800001"],
    ["RTN", "#x3f800000"], ["RTZ", "#x3f800000"]]) {
    cases.push({ name: `fp-round-${mode}`, args: solverArgs, exit: 0, stdout: "unsat\n",
      input: `(set-logic QF_FP)(assert (not (= (fp.add ${mode} ((_ to_fp 8 24) #x3f800000) ((_ to_fp 8 24) #x33800000)) ((_ to_fp 8 24) ${expected}))))(check-sat)\n` });
  }
  cases.push({ name: "fp-nan", args: solverArgs, exit: 0, stdout: "unsat\n",
    input: "(set-logic QF_FP)(assert (not (fp.isNaN (fp.div RNE (_ +zero 8 24) (_ +zero 8 24)))))(check-sat)\n" });
  cases.push({ name: "array-store", args: solverArgs, exit: 0, stdout: "unsat\n",
    input: "(set-logic QF_ABV)(declare-fun a () (Array (_ BitVec 8) (_ BitVec 8)))(assert (not (= (select (store a #x2a #x7f) #x2a) #x7f)))(check-sat)\n" });
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sources = {};
for (const file of ["scripts/probe-extra-solver-cli.mjs", "tests/synth/solver-protocol-helpers.mjs",
  "tests/web/solver-process-helpers.mjs", "tests/web/solver-node-worker.mjs", "web/lib/solver-process.mjs",
  "web/lib/solver-job.mjs", "web/lib/byte-pipe.mjs", "web/lib/smt-response-framer.mjs", "web/lib/wasi-p1.mjs", "web/solver-worker.mjs",
  "scripts/audit-extra-solver-cli.py", "tests/check-solver-protocol/test_extra_cli_audit.py"]) {
  const bytes = readFileSync(path.join(root, file));
  if (values.phase === "formal-probe") assert.deepEqual(bytes, execFileSync("git", ["show", `${commit}:${file}`], { cwd: root }));
  sources[file] = digest(bytes);
  writeFileSync(path.join(output, file.replaceAll("/", "__")), bytes, { flag: "wx" });
}
json("setup.json", { format: 2, purpose: "Diagnostic CLI comparison, not product qualification", solver: values.solver, commit,
  phase: values.phase, repository: root, worktree, sources,
  argv: process.argv.slice(2), node: process.version, cases,
  builds: probes.map(probe => ({ ...probe.info, metadata_sha256: probe.metadataSha256 })),
  negative_build: negative ? { ...negative.info, metadata_sha256: negative.metadataSha256 } : null });

async function run(probe, fixture) {
  const expected = { status: "exited", ...fixture, ...(probe.info.runtime === "wasi" ? fixture.wasi : {}) };
  const started = performance.now();
  writeFileSync(path.join(output, `${probe.info.runtime}-${fixture.name}.stdin`), fixture.input, { flag: "wx" });
  let result;
  let stdout;
  let stderr;
  let writeError = null;
  if (probe.info.runtime === "native") {
    const native = spawnSync(probe.binaryPath, fixture.args, { input: fixture.input, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    stdout = native.stdout ?? Buffer.alloc(0);
    stderr = native.stderr ?? Buffer.alloc(0);
    result = { status: native.error ? "setup-error" : native.signal ? "crashed" : "exited", exitCode: native.status,
      signal: native.signal, error: native.error?.message ?? null, memoryBytes: null };
  } else {
    const out = [];
    const err = [];
    const handle = startSolverProcess({ wasm: probe.binary, sha256: probe.info.artifact.sha256,
      args: [values.solver, ...fixture.args], capacity: 7, timeoutMs: 30000,
      onStdout: bytes => out.push(Buffer.from(bytes)), onStderr: bytes => err.push(Buffer.from(bytes)),
      workerFactory: () => nodeSolverWorker() });
    try {
      const bytes = Buffer.from(fixture.input);
      for (let offset = 0; offset < bytes.length; offset += 3) await handle.write(bytes.subarray(offset, offset + 3));
      handle.endInput();
    } catch (error) { writeError = error.message; }
    result = await handle.completion;
    stdout = Buffer.concat(out);
    stderr = Buffer.concat(err);
  }
  const ended = performance.now();
  const row = { runtime: probe.info.runtime, case: fixture.name, status: result.status, exit_code: result.exitCode,
    signal: result.signal ?? null, elapsed_ms: ended - started, wasm_memory_bytes: result.memoryBytes,
    input_sha256: digest(fixture.input), stdout_sha256: digest(stdout), stderr_sha256: digest(stderr),
    binary_sha256: probe.info.artifact.sha256, build_commit: probe.info.base_commit, metadata_sha256: probe.metadataSha256,
    write_error: writeError };
  const prefix = `${row.runtime}-${fixture.name}`;
  writeFileSync(path.join(output, `${prefix}.stdout`), stdout, { flag: "wx" });
  writeFileSync(path.join(output, `${prefix}.stderr`), stderr, { flag: "wx" });
  json(`${prefix}.json`, { ...row, result, args: fixture.args, started_ms: started, ended_ms: ended });
  appendFileSync(results, csv(columns.map(column => row[column])));
  assert.equal(result.status, expected.status);
  assert.equal(result.exitCode, expected.exit);
  assert.equal(result.signal ?? null, null);
  if (expected.stderr !== undefined) {
    assert.equal(stderr.toString(), expected.stderr);
  } else if (fixture.name !== "syntax" && fixture.name !== "syntax-before-exit-fix") {
    assert.equal(writeError, null);
    assert.equal(stderr.length, 0);
  } else {
    assert.equal(stderr.toString(), "[error] <stdin>:1:19: expected command at 'not-a-command'\n");
    assert.equal(stdout.length, 0);
  }
  if (expected.stdout !== undefined) assert.equal(stdout.toString(), expected.stdout);
  if (fixture.name === "version") assert.equal(stdout.toString().trim(), probe.info.source.version);
  if (fixture.name === "help") assert.match(stdout.toString(), values.solver === "boolector" ? /^usage: boolector / : /^Usage:\n  bitwuzla /);
  return { stdout, stderr };
}

for (const fixture of cases) {
  const native = await run(probes[0], fixture);
  const wasi = await run(probes[1], fixture);
  if (!fixture.wasi) {
    assert.deepEqual(wasi.stdout, native.stdout);
    assert.deepEqual(wasi.stderr, native.stderr);
  }
}
if (negative) {
  const syntax = cases.find(fixture => fixture.name === "syntax");
  await run(negative, { ...syntax, name: "syntax-before-exit-fix", status: "runtime-error", exit: null, stdout: "" });
}
json("summary.json", { status: "pass", commit, phase: values.phase, cases: cases.length, executions: cases.length * probes.length + (negative ? 1 : 0),
  csv_sha256: digest(readFileSync(results)) });
