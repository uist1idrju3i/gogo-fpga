#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createSmtReplay, verifySatReplay } from "../web/lib/formal-replay.mjs";
import { runIverilog } from "../web/lib/iverilog-host.mjs";
import { createMemoryTree, runWasiP1 } from "../web/lib/wasi-p1.mjs";
import { createFormalExecutors } from "../tests/synth/formal-helpers.mjs";
import { nativeSimulation } from "../tests/synth/iverilog-helpers.mjs";
import { sbyCases, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: Object.fromEntries(["traces", "out", "solver"].map(name => [name, { type: "string" }])) });
assert.ok(values.traces && values.out, "Use --traces AUDITED_TRACE_DIRECTORY --out NEW_DIRECTORY [--solver SOLVER]");
const solvers = selectFormalSolvers(values.solver);
const input = path.resolve(values.traces), out = path.resolve(values.out);
assert.ok(!existsSync(out), "Refuse to overwrite replay evidence");
mkdirSync(out);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const save = (name, bytes) => { const target = path.join(out, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); };
const json = (name, data) => save(name, JSON.stringify(data, null, 2) + "\n");
const audit = spawnSync(process.env.PYTHON ?? "python3", [path.join(root, "scripts/audit-formal-trace.py"), input,
  ...solvers.flatMap(solver => ["--solver", solver])], { encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
save("input-audit.stdout", audit.stdout ?? ""); save("input-audit.stderr", audit.stderr ?? "");
json("input-audit.json", { status: audit.status, signal: audit.signal, error: audit.error?.message ?? null });
assert.ifError(audit.error); assert.equal(audit.status, 0, audit.stderr);
const baseline = JSON.parse(readFileSync(path.join(input, "baseline-results.json")));
const traceMetadata = JSON.parse(readFileSync(path.join(input, "metadata.json")));
for (const name of ["metadata.json", "results.json", "baseline-metadata.json", "baseline-results.json", "results.csv"]) {
  save(`upstream/${name}`, readFileSync(path.join(input, name)));
}
const metadata = { format: 1, preliminary: true, command: process.argv, node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  upstreamCommit: traceMetadata.commit, upstreamMetadataSha256: hash(readFileSync(path.join(input, "metadata.json"))),
  versions: {}, builds: {}, snapshots: {}, input: values.traces, solvers };
json("metadata.json", metadata);
for (const name of ["scripts/probe-smt-replay.mjs", "scripts/audit-formal-trace.py", "web/lib/formal-replay.mjs",
  "web/lib/formal-properties.mjs", "web/lib/iverilog-host.mjs", "web/lib/wasi-p1.mjs", "web/lib/verified-assets.mjs",
  "tests/synth/formal-helpers.mjs", "tests/synth/iverilog-helpers.mjs", "tests/synth/formal-sby-cases.mjs"]) {
  const bytes = readFileSync(path.join(root, name)); save(`snapshots/${name}`, bytes); metadata.snapshots[name] = hash(bytes);
}
const yosysPin = execFileSync("python3", [".github/scripts/check-pins.py", "yosys-pin"], { cwd: root, encoding: "utf8" }).trim().split("\t");
const iverilogPin = execFileSync("python3", [".github/scripts/check-pins.py", "iverilog-pin"], { cwd: root, encoding: "utf8" }).trim().split("\t");
const nativeDir = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
for (const [runtime, directory] of [["native", nativeDir], ["wasm", wasmDir]]) {
  const bytes = readFileSync(path.resolve(directory, "../build-info.json"));
  const info = JSON.parse(bytes);
  assert.equal(info.mode, runtime === "wasm" ? "wasi" : runtime);
  assert.deepEqual([info.iverilog.version, info.iverilog.commit], iverilogPin.slice(0, 2));
  for (const [name, artifact] of Object.entries(info.artifacts)) assert.equal(hash(readFileSync(path.join(directory, name))), artifact.sha256);
  save(`build/iverilog-${runtime}.json`, bytes); metadata.builds[`iverilog-${runtime}`] = hash(bytes);
}
for (const [runtime, directory] of [["native", "build/native"], ["wasi", "build/wasi/yosys"]]) {
  const bytes = readFileSync(path.join(root, directory, "build-info.json"));
  const info = JSON.parse(bytes);
  assert.equal(info.mode, runtime);
  assert.deepEqual([info.source.version, info.source.commit], yosysPin.slice(0, 2));
  assert.equal(hash(readFileSync(path.join(root, directory, info.artifact.path))), info.artifact.sha256);
  save(`build/yosys-${runtime}.json`, bytes); metadata.builds[`yosys-${runtime}`] = hash(bytes);
}
assert.equal(JSON.parse(readFileSync(path.join(input, "baseline-metadata.json"))).yosys.sha256,
  JSON.parse(readFileSync(path.join(root, "build/native/build-info.json"))).artifact.sha256);
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map(name => [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, name + ".wasm")))]));
const version = spawnSync(path.join(nativeDir, "vvp"), ["-V"], { encoding: "utf8", timeout: 30_000 });
assert.ifError(version.error); assert.equal(version.status, 0);
const chunks = [];
assert.equal(runWasiP1(modules.vvp, { args: ["vvp", "-V"], preopens: { "/": createMemoryTree({}) },
  stdout: bytes => chunks.push(bytes), stderr: bytes => chunks.push(bytes) }).exitCode, 0);
metadata.versions.iverilog = `${version.stdout}${version.stderr}`.trim();
assert.equal(Buffer.concat(chunks).toString("utf8").trim(), metadata.versions.iverilog);
metadata.versions.yosys = execFileSync(path.join(root, "build/native/yosys"), ["-V"], { encoding: "utf8" }).trim();
json("metadata.json", metadata);
const rows = [];
const columns = ["solver", "case", "origin", "runtime", "phase", "expected", "actual", "exitCode", "elapsedMs", "steps", "failures",
  "sourceSha256", "modelSha256", "captureSha256", "sourceVcdSha256", "designSha256", "replaySha256", "stdoutSha256", "stderrSha256", "vcdSha256", "error"];
save("raw.csv", columns.join(",") + "\n");
function record(row) {
  rows.push(row); appendFileSync(path.join(out, "raw.csv"), columns.map(key => `"${String(row[key] ?? "").replaceAll('"', '""')}"`).join(",") + "\n");
  json("results.json", { preliminary: true, rows });
}
const script = "read_verilog -formal top.v; hierarchy -check -top top; proc; flatten; async2sync; chformal -lower; write_json __formal/before.json";
for (const solver of solvers) for (const fixture of sbyCases.filter(item => item.witness || item.name === "prove-inconclusive")) {
  const phase = fixture.mode === "prove" ? "induction" : fixture.mode;
  for (const origin of ["native", "pyodide"]) {
    const label = `${solver}-${fixture.name}-${origin}`;
    const directory = path.join(input, `${solver}-${fixture.name}-${phase}`, `${origin}-formal_trace/files`);
    const source = readFileSync(path.join(directory, "top.v"));
    const model = readFileSync(path.join(directory, "model.smt2"));
    const captureBytes = readFileSync(path.join(directory, "formal-trace.json"));
    const vcd = readFileSync(path.join(directory, "trace.vcd"));
    const capture = JSON.parse(captureBytes);
    const reference = baseline.rows.find(row => row.solver === solver && row.case === fixture.name);
    assert.ok(reference && !reference.error);
    assert.equal(source.toString("utf8"), fixture.source);
    assert.equal(hash(source), reference.files["top.v"].sha256);
    assert.equal(hash(model), reference.files["result/model/design_smt2.smt2"].sha256);
    for (const [name, bytes] of [["top.v", source], ["model.smt2", model], ["formal-trace.json", captureBytes], ["trace.vcd", vcd]]) save(`${label}/inputs/${name}`, bytes);
    const executors = createFormalExecutors(out, label + "-inventory", source);
    const designs = [];
    for (const runtime of ["native", "wasm"]) {
      const result = await executors[runtime]({ phase: "inventory", script });
      assert.equal(result.exitCode, 0, result.stderr); assert.equal(result.stderr, "");
      designs.push(JSON.parse(new TextDecoder().decode(result.files.get("__formal/before.json"))));
    }
    const normalized = designs.map(({ creator, ...design }) => design);
    assert.deepEqual(normalized[0], normalized[1], "Original-source inventories differ");
    const config = { document: designs[0], top: "top", clock: "clk", depth: fixture.depth, mode: fixture.mode, phase, capture, model, vcd };
    const fields = { solver, case: fixture.name, origin, sourceSha256: hash(source), modelSha256: hash(model),
      captureSha256: hash(captureBytes), sourceVcdSha256: hash(vcd), designSha256: hash(JSON.stringify(designs[0])) };
    if (fixture.mode !== "bmc") {
      const started = performance.now();
      let error;
      try { await createSmtReplay(config); } catch (caught) { error = caught.message; }
      json(`${label}/phase-rejection.json`, { phase, error: error ?? null });
      record({ ...fields, runtime: "none", phase, expected: "rejected", actual: error ? "rejected" : "accepted", elapsedMs: performance.now() - started, error });
      assert.match(error ?? "", /requires an initialized assertion basecase/);
      continue;
    }
    for (const variant of ["positive", "wrong-state"]) {
      const changed = structuredClone(capture);
      if (variant === "wrong-state") {
        const sample = changed.traces[0].steps[1].values.find(value => value.path.join(".") === "top.count");
        sample.bits = sample.bits.replace(/^./, bit => bit === "0" ? "1" : "0");
      }
      const replay = await createSmtReplay({ ...config, capture: changed });
      assert.equal((await createSmtReplay({ ...config, capture: changed, document: designs[1] })).content, replay.content);
      save(`${label}/${variant}/replay.v`, replay.content); json(`${label}/${variant}/plan.json`, replay);
      json(`${label}/${variant}/capture.json`, changed);
      const files = [{ path: "top.v", content: source }, { path: replay.path, content: replay.content }];
      const executions = [];
      for (const runtime of ["native", "wasm"]) {
        const target = `${label}/${variant}/${runtime}`; mkdirSync(path.join(out, target), { recursive: true });
        const started = performance.now();
        const execution = runtime === "native" ? nativeSimulation(path.join(out, target), files,
          { includeDirectories: [], defines: {}, top: "__formal_replay", formal: true, vcdFile: "formal-replay.vcd" }) :
          runIverilog({ modules, files, top: "__formal_replay", formal: true });
        const elapsedMs = performance.now() - started;
        const wave = runtime === "native" ? execution.vcd : execution.tree?.work?.["formal-replay.vcd"];
        const verified = verifySatReplay(replay, { ...execution, vcd: wave });
        const streams = { status: execution.status, stdout: execution.stdout, stderr: execution.stderr };
        json(`${target}/execution.json`, streams); json(`${target}/verification.json`, verified);
        save(`${target}/stdout.log`, execution.stdout); save(`${target}/stderr.log`, execution.stderr);
        save(`${target}/replay.vcd`, wave ?? "");
        if (runtime === "wasm") for (const [stage, result] of Object.entries(execution.stages)) {
          save(`${target}/${stage}.stdout`, result.stdout); save(`${target}/${stage}.stderr`, result.stderr);
          json(`${target}/${stage}.json`, { status: result.status });
        }
        record({ ...fields, runtime, phase: variant, expected: variant === "positive" ? "verified" : "rejected", actual: verified.status,
          exitCode: execution.status, elapsedMs, steps: replay.steps, failures: JSON.stringify(verified.failures ?? []),
          replaySha256: hash(replay.content), stdoutSha256: hash(execution.stdout), stderrSha256: hash(execution.stderr),
          vcdSha256: hash(wave ?? ""), error: verified.reason ?? null });
        assert.equal(verified.status, variant === "positive" ? "verified" : "rejected", JSON.stringify({ streams, verified }));
        executions.push({ streams, verified, vcd: Buffer.from(wave ?? "") });
      }
      assert.deepEqual(executions[1], executions[0], "Icarus native/WASM evidence differs");
      console.log(`${label} ${variant}: ${executions[0].verified.status}`);
    }
  }
}
console.log(JSON.stringify({ preliminary: true, rows: rows.length, columns: columns.length, status: "pass" }));
