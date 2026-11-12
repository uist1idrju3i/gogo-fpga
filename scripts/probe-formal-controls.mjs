import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { readFormalSources } from "../tests/synth/formal-python-helpers.mjs";
import { createFormalControlWorkers } from "../tests/synth/formal-control-workers.mjs";
import { formalControls, formalRestrictions, extraFormalControls } from "../tests/synth/formal-control-cases.mjs";
import { loadSolverProbe, digest, root } from "../tests/synth/solver-protocol-helpers.mjs";
import { sbyCases, sbyConfig, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";
import { readSbyStatus } from "./probe-upstream-formal.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: {
  ...Object.fromEntries(["sources", "probes", "synth", "out", "solver", "case"].map(name => [name, { type: "string" }])),
  formal: { type: "boolean", default: false },
} });
assert.ok(values.sources && values.probes && values.synth && values.out,
  "Use --sources ASSETS --probes MANIFEST --synth YOSYS_ASSETS --out NEW_DIRECTORY");
assert.ok(!existsSync(values.out), "Refuse to overwrite evidence");
const selected = selectFormalSolvers(values.solver);
const extra = selected.every(name => ["bitwuzla", "boolector"].includes(name));
const controls = [...formalControls, ...(extra ? extraFormalControls : [])];
if (values.case) assert.ok([...controls, ...formalRestrictions].some(item => item.name === values.case));
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git(["rev-parse", "HEAD"]);
const worktree = git(["status", "--porcelain"]);
if (values.formal) assert.equal(worktree, "", "Formal controls require a clean commit");
const out = path.resolve(values.out); mkdirSync(out);
const save = (name, bytes) => { const target = path.join(out, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); };
const json = (name, data) => save(name, JSON.stringify(data, null, 2) + "\n");
const sources = readFormalSources(values.sources);
for (const file of sources.sources) save(`assets/${file.path}`, file.bytes);
json("assets/manifest.json", sources.manifest);
const probes = JSON.parse(readFileSync(values.probes));
const manifest = JSON.parse(readFileSync(path.join(values.synth, "manifest.json")));
const asset = name => manifest.assets.find(item => item.path === name);
const yosys = { wasm: new Uint8Array(readFileSync(path.join(values.synth, "yosys.wasm"))), sha256: asset("yosys.wasm").sha256,
  share: new Uint8Array(readFileSync(path.join(values.synth, "yosys-share.tar"))), shareSha256: asset("yosys-share.tar").sha256 };
assert.equal(digest(yosys.wasm), yosys.sha256); assert.equal(digest(yosys.share), yosys.shareSha256);
save("inputs/yosys.wasm", yosys.wasm); save("inputs/yosys-share.tar", yosys.share);
const metadata = { format: 1, preliminary: !values.formal, commit, worktree, command: process.argv.slice(1), startedUtc: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0].model, cpus: os.availableParallelism(), memoryBytes: os.totalmem() },
  environment: Object.fromEntries(["LANG", "LC_ALL", "TZ"].map(name => [name, process.env[name] ?? null])),
  node: process.version, pyodidePackage: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  sources: sources.manifest, yosys: { sha256: yosys.sha256, shareSha256: yosys.shareSha256 }, snapshots: {}, probes: {},
  deadlineMs: 15_000, cleanupDeadlineMs: 5000 };
const snapshots = ["scripts/probe-formal-controls.mjs", "scripts/audit-formal-controls.py", "scripts/audit-formal-sby.py", "scripts/sby-artifact-audit.py",
  "scripts/formal-solver-audit.py",
  "scripts/build-formal-python.py", "scripts/probe-upstream-formal.mjs", "scripts/measure-formal-controls.py",
  "web/formal_process.py", "patches/sby-process.patch", "patches/yosys-smtio-process.patch", "package-lock.json", ".gitmodules",
  ...["formal-python-process", "formal-python-job", "formal-tool-client", "formal-process-client", "formal-tool-process", "formal-tool-command",
    "formal-workspace", "formal-wasi-job", "solver-job", "solver-process", "wasi-p1", "byte-pipe", "verified-assets"].map(name => `web/lib/${name}.mjs`),
  ...["formal-control-workers", "formal-control-cases", "formal-controlled-python-worker", "formal-controlled-solver-worker",
    "formal-sby-cases", "formal-python-helpers", "solver-protocol-helpers"].map(name => `tests/synth/${name}.mjs`), "tests/web/formal-wasi-node-worker.mjs"];
if (values.formal && extra) snapshots.push("scripts/measure-extra-formal.py");
for (const name of snapshots) { const bytes = readFileSync(path.join(root, name)); save(`snapshots/${name}`, bytes); metadata.snapshots[name] = digest(bytes); }
const binaries = new Map();
for (const solver of selected) {
  const probe = loadSolverProbe(probes[solver].wasi, solver, "wasi"); binaries.set(solver, probe);
  metadata.probes[solver] = { sha256: probe.info.artifact.sha256, metadataSha256: probe.metadataSha256 };
  save(`inputs/${solver}.wasm`, probe.binary); save(`build/${solver}.json`, probe.metadata);
}
json("metadata.json", metadata);
const encoder = new TextEncoder();
const rows = [];
const matrix = [...binaries.keys()].flatMap(solver => controls.map(condition => ({ solver, condition })));
matrix.push(...formalRestrictions.map(condition => ({ solver: binaries.keys().next().value, condition })));
for (const { solver, condition } of matrix.filter(item => !values.case || item.condition.name === values.case)) {
  const label = `${condition.restriction ? "restriction" : solver}-${condition.name}`;
  const fixture = sbyCases.find(item => item.name === condition.fixture);
  const files = [{ path: "job.sby", bytes: encoder.encode(sbyConfig(fixture, solver)) }, { path: "top.v", bytes: encoder.encode(fixture.source) }];
  for (const file of files) save(`${label}/input/${file.path}`, file.bytes);
  const stdout = []; const stderr = [];
  const workers = createFormalControlWorkers(condition.mode);
  const probe = binaries.get(solver);
  const args = ["-j", "1", "-d", "result", "--yosys", "yosys", "--smtbmc", "yosys-smtbmc", "--witness", "yosys-witness",
    ...(condition.args ?? []), "job.sby"];
  json(`${label}/request.json`, { solver, condition: condition.name, fixture: fixture.name, args });
  const job = startFormalPython({ ...sources, entrypoint: "sby", args, files,
    solvers: { [solver === "yices2" ? "yices-smt2" : solver]: { wasm: probe.binary, sha256: probe.info.artifact.sha256,
      exitCodes: solver === "boolector" ? [0, 10, 20] : [0] } }, yosys,
    timeoutMs: metadata.deadlineMs, ...workers, onStdout: line => stdout.push(line), onStderr: line => stderr.push(line) });
  workers.setJob(job);
  const result = await job.completion;
  let stopped = []; let error = null;
  try { stopped = await workers.settled(); } catch (failure) { error = failure.message; }
  const { files: artifacts = [], ...transport } = result;
  json(`${label}/transport.json`, transport); json(`${label}/events.json`, workers.events); json(`${label}/workers.json`, stopped);
  save(`${label}/stdout.log`, stdout.join("")); save(`${label}/stderr.log`, stderr.join(""));
  const hashes = {};
  for (const file of artifacts) { save(`${label}/output/${file.path}`, file.bytes); hashes[file.path] = { bytes: file.bytes.length, sha256: digest(file.bytes) }; }
  json(`${label}/files.json`, hashes);
  let sbyStatus = null;
  try {
    assert.equal(error, null); assert.equal(result.status, condition.status, result.error);
    assert.ok(workers.events.some(event => event.event === "native-guards-installed"));
    assert.ok(!/FORBIDDEN_NATIVE_BOUNDARY:/.test(stdout.join("") + stderr.join("")));
    if (condition.diagnostic) assert.ok(stderr.join("").includes(condition.diagnostic), "Expected exact rejection diagnostic");
    if (condition.event) assert.ok(workers.events.some(event => event.event === condition.event), "Required live fault precondition");
    if (condition.sbyStatus) {
      assert.equal(result.exitCode, condition.exitCode); assert.equal(result.integrityVerified, true);
      sbyStatus = readSbyStatus(new TextDecoder().decode(artifacts.find(file => file.path === "result/status").bytes), result.exitCode, stdout.join(""));
      assert.equal(sbyStatus, condition.sbyStatus); assert.ok(stdout.join("").includes("Elapsed process time unavailable in the browser"));
      assert.equal(stderr.join(""), "");
      assert.ok(workers.events.filter(event => event.event === "environment-after-run").every(event => event.makeflags === ""));
    } else {
      assert.equal(artifacts.length, 0); assert.notEqual(result.integrityVerified, true);
      assert.ok(!/DONE \(PASS,/.test(stdout.join("")));
    }
    if (condition.restriction) assert.equal(stopped.length, 1, "Rejected options must not launch any children");
    if (["cancel", "timeout", "crash", "protocol"].includes(condition.mode)) {
      assert.ok(workers.events.some(event => event.event === "solver-stdin-wait" && event.sha256 === probe.info.artifact.sha256));
      assert.ok(stopped.filter(worker => worker.kind === "python").length >= 2);
      assert.ok(result.children.some(child => child.role === "tool" && child.args[0] === "yosys-smtbmc"));
    }
    if (condition.mode === "crash") assert.ok(workers.events.some(event => event.event === "exit" && event.code === 17 && event.expectedTermination === false));
    if (condition.mode === "conflict-delta") assert.ok(workers.events.some(event => event.event === "conflict-root-preserved" && event.sha256 === digest("concurrent root write\n")));
  } catch (failure) { error = failure.message; }
  const row = { condition: label, solver, status: result.status, exitCode: result.exitCode ?? null, sbyStatus,
    elapsedMs: result.elapsedMs, files: artifacts.length, workers: stopped.length, stopped: stopped.filter(worker => worker.exited).length,
    solverWaits: workers.events.filter(event => event.event === "solver-stdin-wait").length,
    solverSha256: probe.info.artifact.sha256, error };
  rows.push(row); json(`${label}/result.json`, row); json("results.json", { preliminary: !values.formal, rows });
  console.log(`${label}: ${error ?? `${result.status}, ${stopped.length} workers stopped`}`);
}
assert.ok(rows.length > 0);
assert.equal(git(["rev-parse", "HEAD"]), commit); assert.equal(git(["status", "--porcelain"]), worktree);
const columns = Object.keys(rows[0]);
const cell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
save("results.csv", [columns, ...rows.map(row => columns.map(name => row[name]))].map(row => row.map(cell).join(",")).join("\n") + "\n");
if (rows.some(row => row.error)) process.exitCode = 1;
