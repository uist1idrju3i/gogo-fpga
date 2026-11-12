#!/usr/bin/env node
// Yosys SAT の形式検証を 1 パス実行し、P6 の 5 回反復に渡す生データを書く。
// verdict 条件を native/WASI の yosys で実行し、反例は Icarus（native/WASI）で独立再実行する。
// --kind error は不正入力の条件を実行し、正常系とは別の出力に error として残す。

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { runSatFormal } from "../web/lib/formal-sat.mjs";
import { createSatReplay, verifySatReplay } from "../web/lib/formal-replay.mjs";
import { runIverilog } from "../web/lib/iverilog-host.mjs";
import { createMemoryTree, runWasiP1 } from "../web/lib/wasi-p1.mjs";
import { createFormalExecutors } from "../tests/synth/formal-helpers.mjs";
import { nativeSimulation } from "../tests/synth/iverilog-helpers.mjs";
import { satFormalCases } from "../tests/synth/formal-sat-cases.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    order: { type: "string", default: "native-first" },
    kind: { type: "string", default: "verdict" },
  },
});
assert.ok(values.out, "--out is required");
assert.ok(["native-first", "wasm-first"].includes(values.order), "unknown --order");
assert.ok(["verdict", "error"].includes(values.kind), "unknown --kind");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  && execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "", "probe requires a clean checkout");

const out = path.resolve(values.out);
assert.ok(!statSync(out, { throwIfNoEntry: false }), `refuse to overwrite probe output: ${out}`);
mkdirSync(out, { recursive: true });

const cases = satFormalCases.filter(({ kind }) => kind === values.kind);
const runtimes = values.order === "native-first" ? ["native", "wasm"] : ["wasm", "native"];

// Icarus Verilog の native/WASI 資材を検証する（formal-replay.test.mjs と同じ fail closed 手順）。
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const nativeDir = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) => [name,
  new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
const [version, commit] = execFileSync("python3", [".github/scripts/check-pins.py", "iverilog-pin"], { cwd: root, encoding: "utf8" }).trim().split("\t");
const iverilog = Object.fromEntries([["native", nativeDir], ["wasm", wasmDir]].map(([runtime, directory]) => {
  const info = JSON.parse(readFileSync(path.resolve(directory, "../build-info.json"), "utf8"));
  assert.equal(info.iverilog.version, version);
  assert.equal(info.iverilog.commit, commit);
  for (const [name, artifact] of Object.entries(info.artifacts)) {
    assert.equal(hash(readFileSync(path.join(directory, name))), artifact.sha256);
  }
  return [runtime, info];
}));
const nativeVvp = spawnSync(path.join(nativeDir, "vvp"), ["-V"], { encoding: "utf8", timeout: 30_000 });
assert.ifError(nativeVvp.error);
assert.equal(nativeVvp.status, 0);
const versionChunks = [];
const wasmVvp = runWasiP1(modules.vvp, {
  args: ["vvp", "-V"], preopens: { "/": createMemoryTree({}) },
  stdout: (bytes) => versionChunks.push(bytes), stderr: (bytes) => versionChunks.push(bytes),
});
assert.equal(wasmVvp.exitCode, 0);
assert.equal(Buffer.concat(versionChunks).toString("utf8").trim(), `${nativeVvp.stdout}${nativeVvp.stderr}`.trim());

const yosysNative = path.join(root, "build/native/yosys");
const yosysWasm = path.join(root, "build/wasi/yosys/yosys.wasm");
const binaries = {};
for (const [runtime, file] of [["native", yosysNative], ["wasm", yosysWasm]]) {
  const bytes = readFileSync(file);
  binaries[`yosys-${runtime}`] = { path: path.relative(root, file), sha256: hash(bytes), bytes: bytes.length };
}
writeFileSync(path.join(out, "metadata.json"), JSON.stringify({
  kind: "sat-formal-probe-v1",
  format: 1,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: "",
  node: process.version,
  order: values.order,
  caseKind: values.kind,
  cases: cases.map(({ name }) => name),
  binaries,
  iverilog: { version, commit, artifacts: Object.fromEntries(Object.entries(iverilog).map(([runtime, info]) => [runtime, info.artifacts])) },
  vvpVersion: `${nativeVvp.stdout}${nativeVvp.stderr}`.trim(),
  host: { platform: process.platform, arch: process.arch },
}, null, 2));

const normalizeVcd = (raw) => {
  const text = typeof raw === "string" ? raw : Buffer.from(raw ?? "").toString("utf8");
  const matches = [...text.matchAll(/\$date\s+[^$]+\$end/g)];
  assert.equal(matches.length, 1, "one replay VCD date");
  return text.replace(matches[0][0], "$date RECORDED $end");
};

const rows = [];
const replays = [];
const failures = [];
for (const { kind: _kind, expected, ...scenario } of cases) {
  const caseDir = path.join(out, scenario.name);
  const execute = createFormalExecutors(out, scenario.name, scenario.source);
  for (const runtime of runtimes) {
    const started = Date.now();
    const result = await runSatFormal({
      sources: ["top.v"], top: "top", depth: scenario.depth ?? 8,
      clock: scenario.clock, edge: scenario.edge, mode: scenario.mode,
      execute: execute[runtime],
    });
    const elapsedMs = Date.now() - started;
    assert.equal(result.status, expected, `${scenario.name}/${runtime}: ${result.message ?? ""}`);
    const observations = result.observations.map(({ phase, exitCode, memoryBytes }) => ({
      phase, exitCode, memoryBytes: memoryBytes ?? null,
    }));
    const nonzero = observations.find(({ exitCode }) => exitCode !== 0);
    rows.push({
      case: scenario.name,
      mode: scenario.mode ?? "bmc",
      depth: scenario.depth ?? 8,
      runtime,
      runtimeIndex: runtimes.indexOf(runtime),
      expected,
      actual: result.status,
      exitCode: nonzero?.exitCode ?? 0,
      elapsedMs,
      wasmMemoryBytes: runtime === "wasm"
        ? Math.max(...observations.map(({ memoryBytes }) => memoryBytes ?? 0)) : null,
      distributionBytes: binaries[`yosys-${runtime}`].bytes,
      sourceSha256: hash(scenario.source),
      phases: observations,
    });
    if (result.status === "error") failures.push({ case: scenario.name, runtime, phase: result.phase, message: result.message });
    if (result.status !== "counterexample") continue;

    const document = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/before.json")));
    const replay = createSatReplay({ ...scenario, top: "top", depth: scenario.depth ?? 8, document, witness: result.witness });
    const replayDir = path.join(caseDir, `${runtime}-replay`);
    mkdirSync(replayDir);
    writeFileSync(path.join(replayDir, "replay.v"), replay.content);
    writeFileSync(path.join(replayDir, "witness.json"), JSON.stringify(result.witness, null, 2));
    const files = [{ path: "top.v", content: scenario.source }, { path: replay.path, content: replay.content }];
    const nativeExecution = nativeSimulation(replayDir, files, {
      includeDirectories: [], defines: {}, top: "__formal_replay", formal: true, vcdFile: "formal-replay.vcd",
    });
    const wasmExecution = runIverilog({ modules, files, top: "__formal_replay", formal: true });
    wasmExecution.vcd = wasmExecution.tree?.work?.["formal-replay.vcd"];
    const checks = [nativeExecution, wasmExecution].map((execution) => verifySatReplay(replay, execution));
    writeFileSync(path.join(replayDir, "wasm-replay.vcd"), wasmExecution.vcd ?? "");
    writeFileSync(path.join(replayDir, "wasm-execution.json"), JSON.stringify({
      status: wasmExecution.status, stdout: wasmExecution.stdout, stderr: wasmExecution.stderr,
    }, null, 2));
    assert.ok(checks.every(({ status }) => status === "verified"), `${scenario.name}/${runtime} replay: ${JSON.stringify(checks)}`);

    // 負の対照: witness の出力 1 bit を反転させた再実行は必ず拒否される。
    const broken = structuredClone(result.witness);
    const output = broken.signal.find(({ name }) => name === "q" || name === "y");
    assert.ok(output, `${scenario.name}: witness output signal`);
    output.data[0] = (output.data[0][0] === "0" ? "1" : "0") + output.data[0].slice(1);
    const invalidReplay = createSatReplay({ ...scenario, top: "top", depth: scenario.depth ?? 8, document, witness: broken });
    const invalidExecution = runIverilog({ modules, files: [files[0], { path: invalidReplay.path, content: invalidReplay.content }], top: "__formal_replay", formal: true });
    invalidExecution.vcd = invalidExecution.tree?.work?.["formal-replay.vcd"];
    const invalid = verifySatReplay(invalidReplay, invalidExecution);
    assert.equal(invalid.status, "rejected", `${scenario.name}/${runtime} negative replay`);
    writeFileSync(path.join(replayDir, "negative-replay.v"), invalidReplay.content);
    writeFileSync(path.join(replayDir, "negative-witness.json"), JSON.stringify(broken, null, 2));
    writeFileSync(path.join(replayDir, "negative-result.json"), JSON.stringify({
      status: invalidExecution.status, stdout: invalidExecution.stdout, stderr: invalidExecution.stderr,
    }, null, 2));

    replays.push({
      case: scenario.name,
      runtime,
      replayStatus: "verified",
      replayNative: checks[0],
      replayWasm: checks[1],
      negativeStatus: invalid.status,
      witnessSha256: hash(JSON.stringify(result.witness)),
      replaySha256: hash(replay.content),
      replayVcdSha256: hash(normalizeVcd(wasmExecution.vcd)),
    });
  }
}

// Yosys の全ログと出力（VCD を除く）の hash。Icarus の再実行ディレクトリーは絶対パスと
// ASLR 由来の scope アドレスを含むため除き、replay 列と再実行出力で別に照合する。
const logHashes = {};
for (const { name } of cases) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (!entry.name.endsWith("-replay")) walk(full); }
      else if (!entry.name.endsWith(".vcd")) entries.push(full);
    }
  };
  walk(path.join(out, name));
  logHashes[name] = hash(JSON.stringify(entries.sort().map((file) => [
    path.relative(out, file), hash(readFileSync(file)),
  ])));
}
for (const row of rows) row.logSha256 = logHashes[row.case];

writeFileSync(path.join(out, "results.json"), JSON.stringify({
  kind: "sat-formal-probe-result-v1",
  format: 1,
  order: values.order,
  caseKind: values.kind,
  cases: cases.map(({ name }) => name),
  rows,
  replays,
  failures,
}, null, 2));
console.log(JSON.stringify({ out, cases: cases.length, rows: rows.length, replays: replays.length }));
