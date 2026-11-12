import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { createFormalControlWorkers } from "../tests/synth/formal-control-workers.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: { sources: { type: "string" }, model: { type: "string" },
  yosys: { type: "string" }, out: { type: "string" }, formal: { type: "boolean" } } });
assert.ok(values.sources && values.model && values.yosys && values.out, "Required: --sources --model --yosys --out");
const root = path.resolve(import.meta.dirname, "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const worktree = git("status", "--porcelain");
if (values.formal) assert.equal(worktree, "", "Formal witness requires clean worktree");
const out = path.resolve(values.out);
assert.ok(!existsSync(out), "Refusing witness output overwrite");
mkdirSync(out, { recursive: true });
const save = (name, raw) => { const target = path.join(out, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, raw, { flag: "wx" }); };
const json = (name, value) => save(name, JSON.stringify(value, null, 2) + "\n");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sourceRoot = path.resolve(values.sources);
const manifest = JSON.parse(readFileSync(path.join(sourceRoot, "manifest.json")));
const sources = manifest.assets.map(asset => {
  const bytes = new Uint8Array(readFileSync(path.join(sourceRoot, asset.path)));
  assert.equal(bytes.length, asset.size); assert.equal(digest(bytes), asset.sha256);
  save(`original-assets/${asset.path}`, bytes);
  return { path: asset.path, bytes };
});
json("original-assets/manifest.json", manifest);
const snapshots = {};
for (const name of ["scripts/probe-formal-witness.mjs", "scripts/audit-formal-witness.py", "scripts/audit-formal-controls.py", "scripts/audit-formal-sby.py", "scripts/sby-artifact-audit.py", "tests/synth/formal-witness-boundary.py",
  "tests/synth/formal-control-workers.mjs", "tests/synth/formal-controlled-python-worker.mjs",
  ...execFileSync("git", ["ls-files", "web/lib/*.mjs", "web/formal_process.py"], { cwd: root, encoding: "utf8" }).trim().split("\n")]) {
  const bytes = readFileSync(path.join(root, name)); save(`snapshots/${name}`, bytes); snapshots[name] = digest(bytes);
}
const yosys = path.resolve(values.yosys);
save("inputs/yosys", readFileSync(yosys)); save("native/design_prep.il", readFileSync(values.model));
const env = { ...process.env, PYTHONPATH: sourceRoot };
const metadata = { format: 1, purpose: "witness-format-boundary-only-not-an-SBY-proof", preliminary: !values.formal,
  host: { platform: process.platform, arch: process.arch, release: os.release(), cpu: os.cpus()[0].model, cpus: os.availableParallelism(), memoryBytes: os.totalmem() },
  commit: git("rev-parse", "HEAD"), worktree, command: process.argv.slice(2), node: process.version, startedUtc: new Date().toISOString(),
  pyodidePackage: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  python: execFileSync(process.env.PYTHON ?? "python3", ["--version"], { env, encoding: "utf8" }).trim(),
  yosys: { sha256: digest(readFileSync(yosys)), version: execFileSync(yosys, ["-V"], { encoding: "utf8" }).trim() }, snapshots };
const pin = manifest.pins.yosys;
assert.ok(metadata.yosys.version.includes(pin.slice(0, 9)), "Native map generator must match source pin");
const scripts = {
  aiger: "read_rtlil design_prep.il; delete */t:$print; hierarchy -simcheck; formalff -assume; flatten; setundef -undriven -anyseq; setattr -unset keep; delete -output; opt -full; techmap; opt -fast; memory_map -formal; formalff -clk2ff -ff2anyinit; simplemap; dffunmap; aigmap; opt_clean; write_aiger -I -B -zinit -no-startoffset -ywmap aiger-map.json design.aig",
  btor: "read_rtlil design_prep.il; hierarchy -simcheck; delete */t:$print; formalff -assume; flatten; setundef -undriven -anyseq; opt -fast; delete -output; dffunmap; write_btor -ywmap btor-map.json design.btor",
};
for (const [name, script] of Object.entries(scripts)) {
  save(`native/${name}.ys`, script + "\n");
  const result = spawnSync(yosys, ["-Q", "-T", "-s", `${name}.ys`], { cwd: path.join(out, "native"), maxBuffer: 16 * 1024 * 1024 });
  save(`native/${name}-stdout.log`, result.stdout); save(`native/${name}-stderr.log`, result.stderr);
  json(`native/${name}-process.json`, { args: ["-Q", "-T", "-s", `${name}.ys`], exitCode: result.status,
    signal: result.signal, error: result.error?.message ?? null, scriptSha256: digest(readFileSync(path.join(out, "native", `${name}.ys`))) });
  assert.equal(result.status, 0, `${name} map generation failed`);
}
save("native/trace.aiw", "1\nb0\n00000\n0\n1\n.\n");
save("native/trace.wit", "sat\nb0\n#0\n0 0\n1 0\n2 000\n@0\n0 0\n@1\n0 1\n.\n");
const cases = [{ conversion: "aiw2yw", trace: "trace.aiw", map: "aiger-map.json", output: "aiger.yw" },
  { conversion: "wit2yw", trace: "trace.wit", map: "btor-map.json", output: "btor.yw" }];
for (const fixture of cases) {
  const args = [path.join(sourceRoot, "witness.py"), fixture.conversion, fixture.trace, fixture.map, fixture.output];
  const result = spawnSync(process.env.PYTHON ?? "python3", args, { env, cwd: path.join(out, "native"), maxBuffer: 16 * 1024 * 1024 });
  save(`native/${fixture.conversion}-stdout.log`, result.stdout); save(`native/${fixture.conversion}-stderr.log`, result.stderr);
  json(`native/${fixture.conversion}-process.json`, { args, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null });
  assert.equal(result.status, 0, `Native ${fixture.conversion} failed`); assert.equal(result.stderr.length, 0);
}
const runtimeManifest = structuredClone(manifest);
const fixture = new Uint8Array(readFileSync(path.join(root, "tests/synth/formal-witness-boundary.py")));
const asset = runtimeManifest.assets.find(item => item.path === "sby.py");
asset.size = fixture.length; asset.sha256 = digest(fixture);
runtimeManifest.test_fixture = "Root SbyPopen boundary fixture, not upstream SBY";
const runtimeSources = sources.map(source => source.path === "sby.py" ? { path: source.path, bytes: fixture } : source);
json("runtime-manifest.json", runtimeManifest); json("metadata.json", metadata);
const files = ["trace.aiw", "trace.wit", "aiger-map.json", "btor-map.json"].map(name =>
  ({ path: `witness/${name}`, bytes: new Uint8Array(readFileSync(path.join(out, "native", name))) }));
const workers = createFormalControlWorkers("normal");
const stdout = [], stderr = [];
const job = startFormalPython({ sources: runtimeSources, manifest: runtimeManifest, entrypoint: "sby", args: [], files,
  solvers: {}, timeoutMs: 60_000, workerFactory: workers.workerFactory, solverWorkerFactory: workers.solverWorkerFactory,
  wasiWorkerFactory: workers.wasiWorkerFactory, onStdout: line => stdout.push(line), onStderr: line => stderr.push(line) });
workers.setJob(job);
const result = await job.completion;
const stopped = await workers.settled();
const { files: output = [], ...transport } = result;
json("transport.json", transport); json("events.json", workers.events); json("workers.json", stopped);
save("stdout.log", stdout.join("")); save("stderr.log", stderr.join(""));
for (const file of output) save(`output/${file.path}`, file.bytes);
assert.equal(result.status, "exited", result.error); assert.equal(result.exitCode, 0); assert.equal(result.integrityVerified, true);
assert.equal(stderr.join(""), ""); assert.equal(stopped.length, 3); assert.ok(stopped.every(worker => worker.exited));
assert.equal(result.children.length, 2); assert.ok(result.children.every(child => child.status === "exited" && child.exitCode === 0 && child.integrityVerified === true));
assert.equal(stdout.join(""), cases.map(item => readFileSync(path.join(out, "native", `${item.conversion}-stdout.log`), "utf8")).join(""));
const rows = cases.map(item => {
  const native = readFileSync(path.join(out, "native", item.output));
  const actual = readFileSync(path.join(out, "output/witness", item.output));
  assert.deepEqual(actual, native, `${item.conversion} witness bytes differ`);
  return { conversion: item.conversion, status: result.status, exitCode: result.exitCode,
    bytes: native.length, sha256: digest(native), mapSha256: digest(readFileSync(path.join(out, "native", item.map))), elapsedMs: result.elapsedMs };
});
json("results.json", { preliminary: !values.formal, rows });
assert.equal(git("rev-parse", "HEAD"), metadata.commit); assert.equal(git("status", "--porcelain"), worktree);
const cell = value => `"${String(value).replaceAll('"', '""')}"`;
const columns = Object.keys(rows[0]);
save("results.csv", [columns, ...rows.map(row => columns.map(key => row[key]))].map(row => row.map(cell).join(",")).join("\n") + "\n");
console.log(JSON.stringify({ status: "pass", rows, workers: stopped.length }));
