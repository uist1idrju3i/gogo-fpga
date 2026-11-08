import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { createSmtReplay, verifySatReplay } from "../web/lib/formal-replay.mjs";
import { runGhdlSynth } from "../web/lib/ghdl-host.mjs";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { runIverilog } from "../web/lib/iverilog-host.mjs";
import { createMemoryTree, runWasiP1 } from "../web/lib/wasi-p1.mjs";
import { createFormalExecutors } from "../tests/synth/formal-helpers.mjs";
import { nativeSimulation } from "../tests/synth/iverilog-helpers.mjs";
import { buildGhdlReplayPlugin, createGhdlReplay, runGhdlReplay, verifyGhdlReplay } from "../tests/synth/ghdl-replay-helpers.mjs";
import { bindLoweredProperties } from "../tests/synth/ghdl-lowered-replay.mjs";
import { nodeFormalWorker, readFormalSources } from "../tests/synth/formal-python-helpers.mjs";
import { selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";
import { smtVhdlReplayCases } from "../tests/synth/formal-smt-vhdl-replay-cases.mjs";
import { normalizeSmtbmcTestbench } from "../tests/synth/formal-trace-compare.mjs";
import { digest, loadSolverProbe, root, verifyNativeSolver } from "../tests/synth/solver-protocol-helpers.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: {
  ...Object.fromEntries(["sources", "probes", "baseline", "out", "solver", "case"].map(name => [name, { type: "string" }])),
  formal: { type: "boolean", default: false },
} });
assert.ok(values.sources && values.probes && values.baseline && values.out,
  "Use --sources ASSETS --probes MANIFEST --baseline NATIVE_CASES --out NEW_DIRECTORY [--solver SOLVER]");
assert.ok(!values.formal || !values.case, "Formal evidence requires every fixture");
const solvers = selectFormalSolvers(values.solver);
const fixtures = smtVhdlReplayCases.filter(fixture => !values.case || fixture.name === values.case);
assert.ok(fixtures.length, "Unknown replay fixture");
const out = path.resolve(values.out), baseline = path.resolve(values.baseline);
assert.ok(!existsSync(out), "Refuse to overwrite replay evidence");
mkdirSync(out);
const save = (name, bytes) => { const target = path.join(out, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); };
const json = (name, value) => save(name, JSON.stringify(value, null, 2) + "\n");
const input = (name, source, sha) => {
  assert.equal(digest(readFileSync(source)), sha, name);
  const target = path.join(out, "inputs", name); mkdirSync(path.dirname(target), { recursive: true });
  linkSync(source, target);
  assert.equal(digest(readFileSync(target)), sha, name);
};
const assets = readFormalSources(values.sources);
const probes = JSON.parse(readFileSync(values.probes));
const references = JSON.parse(readFileSync(path.join(baseline, "results.json"))).rows;
const original = JSON.parse(readFileSync(path.join(baseline, "metadata.json")));
const metadata = { format: 1, preliminary: !values.formal, argv: process.argv, solvers, cases: fixtures.map(fixture => fixture.name),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), node: process.version,
  host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpus: os.availableParallelism(), memoryBytes: os.totalmem() },
  submodules: execFileSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" }).trim(),
  python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
  pyodide: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  environment: { LC_ALL: "C", TZ: "UTC", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" },
  sourcePins: Object.fromEntries(execFileSync("git", ["ls-tree", "HEAD", ...solvers.map(solver => "vendor/" + solver), "vendor/ghdl"], { cwd: root, encoding: "utf8" })
    .trim().split("\n").map(line => { const match = /^160000 commit ([a-f0-9]{40})\tvendor\/(\w+)$/.exec(line); assert.ok(match); return [match[2], match[1]]; })),
  testbenchPolicy: "Cross-runtime PI ordering only; same-runtime raw bytes identical; raw bytes retained",
  assets: assets.manifest, probes: {}, builds: {}, versions: {}, snapshots: {}, baseline: original };
assert.ok(!values.formal || metadata.worktree === "" && original.worktree === "" && original.preliminary === false && original.commit === metadata.commit,
  "Formal replay requires the same clean native baseline commit");
assert.equal(digest(readFileSync(path.join(root, "build/native/yosys"))), original.yosys.sha256);
assert.ok(original.ghdl, "Missing GHDL baseline metadata");
for (const [name, sha] of Object.entries(original.sources)) assert.equal(digest(readFileSync(path.join(root, name))), sha, name);
for (const name of ["metadata.json", "results.json"]) save("baseline/" + name, readFileSync(path.join(baseline, name)));
metadata.baselineHashes = Object.fromEntries(["metadata.json", "results.json"].map(name =>
  [name, digest(readFileSync(path.join(baseline, name)))]));
for (const name of new Set([...Object.keys(original.sources), "scripts/probe-smt-vhdl-replay-cases.mjs", "scripts/probe-upstream-formal.mjs", "scripts/audit-formal-trace.py",
  "scripts/audit-formal-sby.py", "scripts/sby-artifact-audit.py", "scripts/formal-solver-audit.py", "package-lock.json",
  "tests/synth/formal-smt-vhdl-replay-cases.mjs", "tests/synth/formal-helpers.mjs", "tests/synth/iverilog-helpers.mjs",
  "tests/synth/formal-python-helpers.mjs", "tests/synth/solver-protocol-helpers.mjs", "tests/synth/formal-trace-compare.mjs",
  "tests/synth/ghdl-replay-helpers.mjs", "tests/synth/ghdl-replay-vcd.mjs", "tests/synth/ghdl-replay-vpi.c", "web/lib/formal-replay.mjs",
  "tests/web/formal-python-node-worker.mjs",
  "web/lib/formal-properties.mjs", "web/lib/iverilog-host.mjs", "web/lib/wasi-p1.mjs", "web/lib/verified-assets.mjs",
  "web/lib/ghdl-host.mjs", "web/lib/vhdl-order.mjs"])) {
  const bytes = readFileSync(path.join(root, name)); save("snapshots/" + name, bytes); metadata.snapshots[name] = digest(bytes);
}
for (const file of assets.sources) save("assets/" + file.path, file.bytes);
json("assets/manifest.json", assets.manifest);
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const nativeDir = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
for (const [tool, pin, directories] of [
  ["iverilog", "iverilog-pin", [["native", nativeDir], ["wasi", wasmDir]]],
  ["yosys", "yosys-pin", [["native", path.join(root, "build/native")], ["wasi", path.join(root, "build/wasi/yosys")]]],
]) {
  const pinned = execFileSync("python3", [".github/scripts/check-pins.py", pin], { cwd: root, encoding: "utf8" }).trim().split("\t");
  for (const [runtime, directory] of directories) {
    const info = JSON.parse(readFileSync(path.resolve(directory, tool === "iverilog" ? "../build-info.json" : "build-info.json")));
    assert.equal(info.mode, runtime);
    const source = tool === "iverilog" ? info.iverilog : info.source;
    assert.deepEqual([source.version, source.commit], pinned.slice(0, 2));
    const artifacts = tool === "iverilog" ? info.artifacts : { [info.artifact.path]: info.artifact };
    for (const [name, artifact] of Object.entries(artifacts)) {
      assert.equal(digest(readFileSync(path.join(directory, name))), artifact.sha256);
      if (values.formal) input(tool + "-" + runtime + "/" + name, path.join(directory, name), artifact.sha256);
    }
    metadata.builds[tool + "-" + runtime] = info;
    json("build/" + tool + "-" + runtime + ".json", info);
  }
}
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map(name => [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, name + ".wasm")))]));
const version = spawnSync(path.join(nativeDir, "vvp"), ["-V"], { encoding: "utf8", timeout: 30_000 });
assert.ifError(version.error); assert.equal(version.status, 0);
const chunks = [];
assert.equal(runWasiP1(modules.vvp, { args: ["vvp", "-V"], preopens: { "/": createMemoryTree({}) },
  stdout: bytes => chunks.push(bytes), stderr: bytes => chunks.push(bytes) }).exitCode, 0);
metadata.versions.iverilog = `${version.stdout}${version.stderr}`.trim();
assert.equal(Buffer.concat(chunks).toString("utf8").trim(), metadata.versions.iverilog);
json("versions/native-vvp.json", { status: version.status, stdout: version.stdout, stderr: version.stderr });
save("versions/wasi-vvp.log", Buffer.concat(chunks));
metadata.versions.yosys = execFileSync(path.join(root, "build/native/yosys"), ["-V"], { encoding: "utf8" }).trim();
const ghdlNative = path.join(root, "build/ghdl-native/bin/ghdl");
const ghdlWasm = path.join(root, "build/ghdl-wasm/ghdl-synth.wasm");
assert.equal(digest(readFileSync(ghdlNative)), original.ghdl.sha256, "GHDL native binary changed");
const ghdlVersion = spawnSync(ghdlNative, ["--version"], { encoding: "utf8", timeout: 30_000 });
assert.ifError(ghdlVersion.error); assert.equal(ghdlVersion.status, 0);
json("versions/ghdl-native.json", { status: ghdlVersion.status, stdout: ghdlVersion.stdout, stderr: ghdlVersion.stderr });
metadata.versions.ghdl = ghdlVersion.stdout.split("\n")[0].trim();
assert.equal(metadata.versions.ghdl, original.ghdl.version, "GHDL version changed");
function loadTree(directory) {
  return Object.fromEntries(readdirSync(directory).map((name) => {
    const file = path.join(directory, name);
    return [name, statSync(file).isDirectory() ? loadTree(file) : new Uint8Array(readFileSync(file))];
  }));
}
const librariesTree = loadTree(path.join(root, "build/ghdl-native/lib/ghdl"));
const ghdlManifest = readFileSync(path.join(root, "build/ghdl-wasm/build-manifest.tsv"), "utf8");
const ghdlChecksums = readFileSync(path.join(root, "build/ghdl-wasm/SHA256SUMS"), "utf8");
assert.equal(ghdlChecksums.split(/\s+/)[0], digest(readFileSync(ghdlWasm)), "GHDL WASM binary changed");
const libraryFiles = (directory, prefix = "") => readdirSync(directory).sort().flatMap((name) => {
  const file = path.join(directory, name);
  return statSync(file).isDirectory() ? libraryFiles(file, prefix + name + "/") : [[prefix + name, digest(readFileSync(file))]];
});
metadata.ghdl = { native: original.ghdl, wasm: { sha256: digest(readFileSync(ghdlWasm)) }, wasmManifest: digest(ghdlManifest), wasmChecksums: digest(ghdlChecksums),
  libraries: Object.fromEntries(libraryFiles(path.join(root, "build/ghdl-native/lib/ghdl"))) };
save("build/ghdl-wasm-build-manifest.tsv", ghdlManifest);
if (values.formal) {
  input("ghdl-native/ghdl", ghdlNative, original.ghdl.sha256);
  input("ghdl-wasm/ghdl-synth.wasm", ghdlWasm, metadata.ghdl.wasm.sha256);
}
const vpiConfig = Object.fromEntries(["cflags", "ldflags", "include-dir", "library-dir"].map((name) => [name,
  execFileSync(ghdlNative, [`--vpi-${name}`], { encoding: "utf8" }).trim()]));
const replayPlugin = buildGhdlReplayPlugin(ghdlNative, path.join(out, "ghdl-replay-plugin"));
json("build/ghdl-replay-plugin.json", { plugin: replayPlugin, sha256: digest(readFileSync(replayPlugin)), vpiConfig });
const columns = ["solver", "case", "origin", "runtime", "target", "phase", "expected", "actual", "exitCode", "elapsedMs", "steps", "failures",
  "sourceSha256", "vhdlSha256", "loweredSha256", "modelSha256", "captureSha256", "sourceVcdSha256", "designSha256", "replaySha256",
  "stdoutSha256", "stderrSha256", "vcdSha256", "pslReportSha256", "error"];
const rows = [];
function record(row) {
  rows.push(Object.fromEntries(columns.map(name => [name, row[name] ?? null])));
  json("results.json", { preliminary: !values.formal, columns, rows });
  save("results.csv", columns.join(",") + "\n" + rows.map(item => columns.map(name => `"${String(item[name] ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n");
}
function lowerVhdl(fixture, directory) {
  mkdirSync(directory, { recursive: true });
  save(path.relative(out, directory) + "/top.vhd", fixture.source);
  const flags = ["--std=08", ...(fixture.psl ? ["-fpsl"] : [])];
  const analyze = spawnSync(ghdlNative, ["-a", ...flags, "top.vhd"], { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(directory, "analyze.stdout"), analyze.stdout ?? "");
  writeFileSync(path.join(directory, "analyze.stderr"), analyze.stderr ?? "");
  assert.ifError(analyze.error); assert.equal(analyze.status, 0, analyze.stderr);
  const compiled = spawnSync(ghdlNative, ["--synth", ...flags, "--out=verilog", "--formal-verilog", "top"], { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(directory, "lower.stdout"), compiled.stdout);
  writeFileSync(path.join(directory, "lower.stderr"), compiled.stderr);
  assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr);
  assert.ok(compiled.stdout.trim(), "Missing lowered Verilog");
  const wasmResult = runGhdlSynth({ module: new WebAssembly.Module(readFileSync(ghdlWasm)), librariesTree,
    files: [{ path: "top.vhd", content: new TextEncoder().encode(fixture.source) }], top: "top", formal: true, psl: fixture.psl });
  save(path.relative(out, directory) + "/wasm.v", wasmResult.verilog);
  save(path.relative(out, directory) + "/wasm.log", wasmResult.log);
  assert.equal(wasmResult.status, 0, wasmResult.log);
  assert.equal(wasmResult.verilog, compiled.stdout, "GHDL native/WASM lowering differs");
  writeFileSync(path.join(directory, "top.v"), compiled.stdout);
  return compiled.stdout;
}
const stateSignals = document => {
  const module = document.modules.top, owners = new Map(), names = new Set();
  for (const [name, net] of Object.entries(module.netnames ?? {})) {
    for (const bit of net.bits ?? []) {
      const list = owners.get(bit) ?? []; list.push(name); owners.set(bit, list);
    }
  }
  for (const cell of Object.values(module.cells)) {
    if (cell.type === "$dff") for (const bit of cell.connections?.Q ?? []) {
      for (const name of owners.get(bit) ?? []) {
        if (name !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !Object.hasOwn(module.ports, name)) names.add(name);
      }
    }
  }
  return [...names];
};
const inventories = new Map(), emitted = new Map();
const script = "read_verilog -formal -icells top.v; hierarchy -check -top top; proc; flatten; async2sync; chformal -lower; write_json __formal/before.json";
const emitScript = "read_verilog -formal -icells top.v; hierarchy -top top; proc; flatten; async2sync; chformal -cover -remove; write_verilog __formal/replay-design.v";
const inspectScript = "read_verilog -formal top.v; hierarchy -check -top top; proc; flatten; async2sync; chformal -lower; write_json __formal/before.json";
const normalized = text => text.replace(/^##\s+\d+:\d\d:\d\d\s+/gm, "## TIME ");
json("metadata.json", metadata);
for (const solver of solvers) {
  const native = loadSolverProbe(probes[solver].native, solver, "native"), wasi = loadSolverProbe(probes[solver].wasi, solver, "wasi");
  assert.deepEqual(native.info.source, wasi.info.source);
  const executable = solver === "yices2" ? "yices-smt2" : solver;
  const bin = path.join(out, solver + "-bin"); mkdirSync(bin); symlinkSync(native.binaryPath, path.join(bin, executable));
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LC_ALL: "C", TZ: "UTC", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" };
  metadata.probes[solver] = { command: verifyNativeSolver(executable, bin, native.info.artifact.sha256, env), native: native.info, wasi: wasi.info };
  const nativeVersion = spawnSync(native.binaryPath, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  assert.ifError(nativeVersion.error); assert.equal(nativeVersion.status, 0);
  const wasiVersionOutput = [], wasiVersionErrors = [];
  const wasiVersion = runWasiP1(new WebAssembly.Module(wasi.binary), { args: [solver, "--version"],
    preopens: { "/": createMemoryTree({}) }, stdout: bytes => wasiVersionOutput.push(bytes), stderr: bytes => wasiVersionErrors.push(bytes) });
  assert.equal(wasiVersion.exitCode, 0);
  const versionRecords = {
    native: { status: nativeVersion.status, stdout: nativeVersion.stdout, stderr: nativeVersion.stderr },
    wasi: { status: wasiVersion.exitCode, stdout: Buffer.concat(wasiVersionOutput).toString("utf8"), stderr: Buffer.concat(wasiVersionErrors).toString("utf8") },
  };
  const release = native.info.source.version.match(/\d+\.\d+\.\d+/)?.[0]; assert.ok(release);
  metadata.versions[solver] = {};
  for (const [runtime, record] of Object.entries(versionRecords)) {
    assert.ok((record.stdout + record.stderr).includes(release));
    json("versions/" + solver + "-" + runtime + ".json", record);
    metadata.versions[solver][runtime] = (record.stdout + record.stderr).trim();
  }
  for (const [runtime, probe] of [["native", native], ["wasi", wasi]]) {
    save("inputs/" + solver + "-" + runtime + "-build.py", probe.buildScript);
    for (const patch of probe.info.patches) {
      const bytes = readFileSync(path.join(root, patch.path));
      save("snapshots/" + patch.path, bytes); metadata.snapshots[patch.path] = digest(bytes);
    }
  }
  if (values.formal) {
    input(solver + "-native", native.binaryPath, native.info.artifact.sha256);
    save("inputs/" + solver + ".wasm", wasi.binary);
    assert.equal(digest(readFileSync(path.join(out, "inputs/" + solver + ".wasm"))), wasi.info.artifact.sha256);
  }
  metadata.probes[solver].command.resolvedPath = realpathSync(path.join(bin, executable));
  assert.equal(metadata.probes[solver].command.resolvedPath, realpathSync(native.binaryPath));
  json("metadata.json", metadata);
  for (const fixture of fixtures) {
    const reference = references.find(item => item.solver === solver && item.case === fixture.name);
    assert.ok(reference, "Missing native reference");
    if (reference.error) {
      // The upstream baseline itself failed for this case (e.g. smtbmc crashing
      // on a solver's output format): keep its logs and record a solver-side tool error.
      assert.ok(fixture.kind === "counterexample" && reference.status === "ERROR" && reference.exitCode === 16, reference.error);
      const label = solver + "-" + fixture.name;
      json(label + "/upstream.json", reference);
      const engineLogs = Object.keys(reference.files).filter(name => /^result\/engine_0\/logfile[^/]*\.txt$/.test(name)).sort();
      assert.ok(engineLogs.length > 0, "Missing upstream engine log");
      for (const name of ["top.vhd", "top.v", ...engineLogs, "result/logfile.txt"]) {
        const bytes = readFileSync(path.join(baseline, label, name));
        assert.equal(digest(bytes), reference.files[name].sha256, name);
        save(label + "/baseline/" + name, bytes);
      }
      record({ solver, case: fixture.name, origin: "native", runtime: "none", target: "none",
        phase: fixture.mode === "prove" ? "basecase" : "bmc", expected: "tool-error", actual: "tool-error",
        exitCode: reference.exitCode, elapsedMs: reference.elapsedMs,
        sourceSha256: digest(fixture.source), vhdlSha256: digest(fixture.source), loweredSha256: reference.files["top.v"].sha256,
        error: "Upstream SBY ERROR exit 16" });
      continue;
    }
    const lowered = lowerVhdl(fixture, path.join(out, "lowered", fixture.name));
    assert.equal(reference.files["top.v"].sha256, digest(lowered));
    assert.equal(reference.files["top.vhd"].sha256, digest(fixture.source));
    if (!inventories.has(fixture.name)) {
      const execute = createFormalExecutors(out, fixture.name + "-inventory", lowered), documents = [];
      for (const runtime of ["native", "wasm"]) {
        const result = await execute[runtime]({ phase: "inventory", script });
        assert.equal(result.exitCode, 0, result.stderr);
        const bytes = result.files.get("__formal/before.json");
        save(fixture.name + "-inventory/" + runtime + ".json", bytes); documents.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
      }
      assert.deepEqual(documents.map(({ creator, ...document }) => document)[0], documents.map(({ creator, ...document }) => document)[1]);
      inventories.set(fixture.name, documents);
    }
    const documents = inventories.get(fixture.name), phase = fixture.mode === "prove" ? "basecase" : "bmc";
    const config = { ...fixture, phase, top: "top", document: documents[0], observe: stateSignals(documents[0]) };
    if (!emitted.has(fixture.name) && !["bounded-pass", "tool-error"].includes(fixture.kind)) {
      const execute = createFormalExecutors(out, fixture.name + "-emit", lowered), pair = [];
      for (const runtime of ["native", "wasm"]) {
        const result = await execute[runtime]({ phase: "emit", script: emitScript });
        assert.equal(result.exitCode, 0, result.stderr);
        const bytes = result.files.get("__formal/replay-design.v");
        save(fixture.name + "-emit/" + runtime + ".v", bytes);
        const emittedSource = "`timescale 1ns/1ps\n" + new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const inspect = createFormalExecutors(out, fixture.name + "-emitted-" + runtime, emittedSource);
        const inspected = await inspect[runtime]({ phase: "inspect", script: inspectScript });
        assert.equal(inspected.exitCode, 0, inspected.stderr);
        const emittedBytes = inspected.files.get("__formal/before.json");
        save(fixture.name + "-emit/" + runtime + ".json", emittedBytes);
        pair.push([emittedSource, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(emittedBytes))]);
      }
      const withoutBanner = source => source.replace(/^\/\* Generated by Yosys [^\n]*\n/m, "");
      assert.equal(withoutBanner(pair[0][0]), withoutBanner(pair[1][0]), "Native/WASM emitted replay design differs");
      assert.deepEqual(pair.map(([, { creator, ...document }]) => document)[0], pair.map(([, { creator, ...document }]) => document)[1]);
      emitted.set(fixture.name, { source: pair[0][0], document: pair[0][1] });
    }
    const base = { solver, case: fixture.name, phase, sourceSha256: digest(fixture.source), vhdlSha256: digest(fixture.source),
      loweredSha256: digest(lowered), designSha256: digest(JSON.stringify(documents[0])) };
    if (fixture.kind === "tool-error") {
      const label = solver + "-" + fixture.name;
      save(label + "/top.vhd", fixture.source); save(label + "/top.v", lowered); json(label + "/upstream.json", reference);
      record({ ...base, origin: "native", runtime: "none", target: "none", expected: "tool-error", actual: reference.kind, exitCode: reference.exitCode, elapsedMs: reference.elapsedMs });
      continue;
    }
    const model = readFileSync(path.join(baseline, `${solver}-${fixture.name}/result/model/design_smt2.smt2`));
    assert.equal(digest(model), reference.files["result/model/design_smt2.smt2"].sha256);
    const expectedCode = fixture.status === "PASS" ? 0 : 1, expectedTrace = fixture.witness;
    const args = ["-s", solver === "yices2" ? "yices" : solver, "--presat", "--noprogress", ...(solver === "yices2" ? ["--unroll"] : []),
      "-t", String(fixture.depth), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"];
    let originalOutput, originalRecord;
    const runtimeOutputs = new Map();
    for (const origin of ["native", "pyodide"]) for (const entrypoint of ["smtbmc", "formal_trace"]) {
      const label = `${solver}-${fixture.name}/${origin}-${entrypoint}`, directory = path.join(out, label), working = path.join(directory, "files");
      mkdirSync(working, { recursive: true });
      const files = [{ path: "top.v", bytes: new TextEncoder().encode(lowered) }, { path: "model.smt2", bytes: new Uint8Array(model) }];
      for (const file of files) save(label + "/files/" + file.path, file.bytes);
      let result, stdout, stderr;
      const started = performance.now();
      if (origin === "native") {
        const source = entrypoint === "smtbmc" ? path.join(root, "vendor/yosys/backends/smt2/smtbmc.py") : path.resolve(values.sources, "formal_trace.py");
        const process = spawnSync("python3", [source, ...args], { cwd: working, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        stdout = process.stdout ?? ""; stderr = process.stderr ?? "";
        result = { status: process.error ? "runtime-error" : "exited", exitCode: process.status, signal: process.signal, error: process.error?.message ?? null, elapsedMs: performance.now() - started };
      } else {
        const output = [], errors = [];
        result = await startFormalPython({ ...assets, entrypoint, args, files,
          solvers: { [executable]: { wasm: wasi.binary, sha256: wasi.info.artifact.sha256, exitCodes: solver === "boolector" ? [0, 10, 20] : [0] } },
          workerFactory: nodeFormalWorker, solverWorkerFactory: () => nodeSolverWorker(), timeoutMs: 30_000,
          onStdout: line => output.push(line), onStderr: line => errors.push(line),
        }).completion;
        stdout = output.join(""); stderr = errors.join("");
        for (const file of result.files ?? []) save(label + "/files/" + file.path, file.bytes);
      }
      const { files: returnedFiles, ...state } = result;
      json(label + "/process.json", { args, ...state }); save(label + "/stdout.log", stdout); save(label + "/stderr.log", stderr);
      assert.equal(result.status, "exited", result.error); assert.equal(result.exitCode, expectedCode, stderr);
      if (origin === "pyodide") {
        assert.equal(result.integrityVerified, true); assert.equal(result.children.length, solver === "bitwuzla" ? 2 : 1);
        assert.ok(result.children.every(child => child.status === "exited" && child.integrityVerified && child.exitCodes.includes(child.exitCode)));
      }
      const artifacts = Object.fromEntries(["model.smt2", "top.v", ...(expectedTrace ? ["trace.vcd", "trace.yw", "trace_tb.v"] : [])].map(name => [name, digest(readFileSync(path.join(working, name)))]));
      const sameRuntime = { stdout: normalized(stdout), stderr, artifacts: { ...artifacts } };
      if (!runtimeOutputs.has(origin)) runtimeOutputs.set(origin, sameRuntime);
      assert.deepEqual(sameRuntime, runtimeOutputs.get(origin), "Recording must preserve every original artifact byte");
      if (expectedTrace) artifacts["trace_tb.v"] = digest(normalizeSmtbmcTestbench(readFileSync(path.join(working, "trace_tb.v"), "utf8")));
      const comparison = { stdout: normalized(stdout), stderr, artifacts };
      if (!originalOutput) originalOutput = comparison;
      assert.deepEqual(comparison, originalOutput);
      if (entrypoint !== "formal_trace") continue;
      const captureBytes = readFileSync(path.join(working, "formal-trace.json")), capture = JSON.parse(captureBytes);
      assert.equal(capture.upstreamExitCode, expectedCode); assert.equal(capture.traces.length, Number(expectedTrace));
      if (!originalRecord) originalRecord = captureBytes;
      assert.deepEqual(captureBytes, originalRecord);
      const vcd = expectedTrace ? readFileSync(path.join(working, "trace.vcd")) : new Uint8Array();
      const fields = { ...base, origin, modelSha256: digest(model), captureSha256: digest(captureBytes), sourceVcdSha256: digest(vcd) };
      let replay, rejection;
      try { replay = await createSmtReplay({ ...config, capture, model, vcd }); } catch (error) { rejection = error.message; }
      if (fixture.replay === "rejected") {
        json(label + "/rejection.json", { reason: rejection ?? null });
        record({ ...fields, runtime: "none", target: "none", expected: "rejected", actual: rejection ? "rejected" : "accepted", exitCode: result.exitCode, elapsedMs: result.elapsedMs, error: rejection });
        assert.ok(rejection, "Unsupported input was accepted"); continue;
      }
      assert.equal(rejection, undefined);
      assert.equal((await createSmtReplay({ ...config, capture, model, vcd, document: documents[1] })).content, replay.content);
      save(label + "/replay.v", replay.content); json(label + "/plan.json", replay);
      const emittedDesign = emitted.get(fixture.name);
      const loweredPlan = bindLoweredProperties(replay, documents[0], emittedDesign.document,
        { top: "top", clock: fixture.clock, edge: fixture.edge, mode: fixture.mode });
      json(label + "/lowered-plan.json", { ...loweredPlan, content: undefined, contentSha256: digest(loweredPlan.content) });
      for (const runtime of ["native", "wasm"]) {
        const target = label + "/replay-lowered-" + runtime; mkdirSync(path.join(out, target));
        const input = [{ path: "top.v", content: emittedDesign.source }, { path: replay.path, content: replay.content }];
        const started = performance.now();
        const execution = runtime === "native" ? nativeSimulation(path.join(out, target), input,
          { includeDirectories: [], defines: {}, top: "__formal_replay", formal: true, vcdFile: "formal-replay.vcd" }) :
          runIverilog({ modules, files: input, top: "__formal_replay", formal: true });
        const elapsedMs = performance.now() - started;
        const wave = runtime === "native" ? execution.vcd : execution.tree?.work?.["formal-replay.vcd"];
        const verification = verifySatReplay(loweredPlan, { ...execution, vcd: wave });
        json(target + "/execution.json", { status: execution.status, elapsedMs }); json(target + "/verification.json", verification);
        save(target + "/stdout.log", execution.stdout); save(target + "/stderr.log", execution.stderr); save(target + "/replay.vcd", wave ?? "");
        record({ ...fields, runtime, target: "lowered", expected: "verified", actual: verification.status, exitCode: execution.status,
          elapsedMs, steps: replay.steps, failures: JSON.stringify(verification.failures ?? []),
          replaySha256: digest(replay.content), stdoutSha256: digest(execution.stdout), stderrSha256: digest(execution.stderr),
          vcdSha256: digest(wave ?? ""), error: verification.reason });
        assert.equal(verification.status, "verified", `${label}/lowered-${runtime}: ${verification.reason}`);
      }
      const ghdlPlan = createGhdlReplay(replay, { top: "top", psl: fixture.psl });
      save(label + "/ghdl-replay.txt", ghdlPlan.content); json(label + "/ghdl-plan.json", { ...ghdlPlan, content: undefined, contentSha256: digest(ghdlPlan.content) });
      const target = label + "/replay-vhdl";
      const startedGhdl = performance.now();
      const execution = runGhdlReplay({ native: ghdlNative, plugin: replayPlugin, directory: path.join(out, target), source: fixture.source, plan: ghdlPlan });
      const elapsedMs = performance.now() - startedGhdl;
      const verification = verifyGhdlReplay(ghdlPlan, execution);
      json(target + "/execution.json", { status: execution.status, elapsedMs }); json(target + "/verification.json", verification);
      const expectedVhdl = fixture.vhdlReplay ?? fixture.replay;
      record({ ...fields, runtime: "ghdl", target: "vhdl", expected: expectedVhdl, actual: verification.status, exitCode: execution.status,
        elapsedMs, steps: ghdlPlan.steps, failures: JSON.stringify(verification.failures ?? []),
        replaySha256: digest(ghdlPlan.content), stdoutSha256: digest(execution.stdout ?? ""), stderrSha256: digest(execution.stderr ?? ""),
        vcdSha256: digest(execution.vcd ?? ""), pslReportSha256: digest(execution.pslReport ?? ""), error: verification.reason });
      assert.equal(verification.status, expectedVhdl, `${label}/vhdl: ${verification.reason}`);
    }
  }
  json("metadata.json", metadata);
}
console.log(`recorded ${rows.length} rows`);
