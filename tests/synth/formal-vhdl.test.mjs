import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { runSatFormal } from "../../web/lib/formal-sat.mjs";
import { createSatReplay } from "../../web/lib/formal-replay.mjs";
import { createFormalExecutors } from "./formal-helpers.mjs";
import { buildGhdlReplayPlugin, createGhdlReplay, runGhdlReplay, verifyGhdlReplay } from "./ghdl-replay-helpers.mjs";
import { auditGhdlReplay, columns as replayColumns, parseReplayCsv } from "../../scripts/audit-ghdl-replay.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const build = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
const native = path.join(build, "ghdl-native/bin/ghdl");
const wasmPath = path.join(build, "ghdl-wasm/ghdl-synth.wasm");
const wasm = new WebAssembly.Module(readFileSync(wasmPath));
function loadTree(directory) {
  return Object.fromEntries(readdirSync(directory).map((name) => {
    const file = path.join(directory, name);
    return [name, statSync(file).isDirectory() ? loadTree(file) : new Uint8Array(readFileSync(file))];
  }));
}
const librariesTree = loadTree(path.join(build, "ghdl-native/lib/ghdl"));
mkdirSync(path.join(root, "build/S15"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/S15/p1-vhdl-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = readFileSync(path.join(build, "ghdl-wasm/build-manifest.tsv"), "utf8");
const metadata = Object.fromEntries(manifest.trim().split("\n").map((row) => row.split("\t")));
assert.equal(hash(readFileSync(native)), metadata.native_sha256);
for (const input of ["patches/ghdl/formal-verilog.patch", "patches/ghdl/formal-verilog-driver.patch", "scripts/ghdl-wasm/synth_api.ads", "scripts/ghdl-wasm/synth_api.adb"]) {
  assert.equal(hash(readFileSync(path.join(root, input))), metadata[`source_sha256:${input}`]);
}
const checksums = readFileSync(path.join(build, "ghdl-wasm/SHA256SUMS"), "utf8");
assert.equal(checksums.split(/\s+/)[0], hash(readFileSync(wasmPath)));
writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version, nativeVersion: execFileSync(native, ["--version"], { encoding: "utf8" }),
  nativeSha256: hash(readFileSync(native)), wasmSha256: hash(readFileSync(wasmPath)), buildManifest: metadata,
}, null, 2));
console.log(`Retained VHDL formal evidence: ${evidence}`);
const replayPlugin = buildGhdlReplayPlugin(native, path.join(evidence, "native-replay-plugin"));
const vpiConfig = Object.fromEntries(["cflags", "ldflags", "include-dir", "library-dir"].map((name) => [name,
  execFileSync(native, [`--vpi-${name}`], { encoding: "utf8" }).trim()]));
writeFileSync(path.join(evidence, "native-replay-manifest.json"), JSON.stringify({
  compiler: execFileSync("gcc", ["--version"], { encoding: "utf8" }), vpiConfig,
  hashes: Object.fromEntries([
    native, replayPlugin, path.join(vpiConfig["include-dir"], "vpi_user.h"), path.join(vpiConfig["library-dir"], "libghdlvpi.so"),
    "tests/synth/ghdl-replay-vpi.c", "tests/synth/ghdl-replay-helpers.mjs", "tests/synth/ghdl-replay-vcd.mjs",
  ].map((name) => [path.relative(root, name), hash(readFileSync(name))])),
}, null, 2));
const replayCsv = path.join(evidence, "native-replay.csv");
writeFileSync(replayCsv, replayColumns.join(",") + "\n", { flag: "wx" });
function replayOriginal(scenario, frontend, runtime, witness, plan, directory, phase = "positive") {
  const execution = runGhdlReplay({ native, plugin: replayPlugin, directory, source: scenario.source, plan });
  const verification = verifyGhdlReplay(plan, execution);
  writeFileSync(path.join(directory, "verification.json"), JSON.stringify(verification, null, 2));
  writeFileSync(path.join(directory, "witness.json"), JSON.stringify(witness, null, 2));
  writeFileSync(path.join(directory, "plan.json"), JSON.stringify(plan, null, 2));
  const row = { case: scenario.name, frontend, runtime, phase, expected: phase === "positive" ? "verified" : "rejected",
    actual: verification.status, exitStatus: execution.status, signal: execution.signal, error: execution.error,
    elapsedMs: execution.elapsedMs, steps: plan.steps, failures: JSON.stringify(verification.failures ?? verification.reason),
    sourceSha256: hash(scenario.source), witnessSha256: hash(JSON.stringify(witness)), protocolSha256: hash(plan.content),
    stdoutSha256: hash(execution.stdout ?? ""), stderrSha256: hash(execution.stderr ?? ""), vcdSha256: hash(execution.vcd), pslReportSha256: hash(execution.pslReport) };
  appendFileSync(replayCsv, replayColumns.map((name) => `"${String(row[name]).replaceAll('"', '""')}"`).join(",") + "\n");
  assert.equal(verification.status, row.expected, `${scenario.name}/${phase}: ${verification.reason}`);
}

const counter = (property, edge = "rising_edge") => `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk, a : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := (others => '0');
begin
  process(clk) begin
    if ${edge}(clk) then count <= count + 1; end if;
  end process;
  q <= count;
${property}
end architecture;
`;
const plain = counter("  P_BOUND: assert count < 3;");
const psl = counter(`  -- psl default clock is rising_edge(clk);
  -- psl P_BOUND: assert always (count < 3);
  -- psl A_INPUT: assume always (a = '0');
  -- psl C_REACH: cover {count = 2};`);
const rows = ["case,frontend,runtime,expected,actual,assertions,assumptions,covers,sourceSha256,verilogSha256,inventorySha256"];
function saveResult(filename, result) {
  writeFileSync(filename, JSON.stringify({ ...result, observations: result.observations.map(({ files, ...observation }) => ({
    ...observation, files: [...files.keys()],
  })) }, null, 2));
}
function lower(name, source, { formal = true, psl = false } = {}) {
  const directory = path.join(evidence, name);
  mkdirSync(directory);
  writeFileSync(path.join(directory, "top.vhd"), source);
  const flags = ["--std=08", ...(psl ? ["-fpsl"] : [])];
  const analyze = spawnSync(native, ["-a", ...flags, "top.vhd"], {
    cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  writeFileSync(path.join(directory, "analyze.stdout"), analyze.stdout ?? "");
  writeFileSync(path.join(directory, "analyze.stderr"), analyze.stderr ?? "");
  assert.ifError(analyze.error);
  assert.equal(analyze.status, 0, analyze.stderr);
  const compiled = spawnSync(native, ["--synth", ...flags, "--out=verilog", ...(formal ? ["--formal-verilog"] : []), "top"], {
    cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.ifError(compiled.error);
  writeFileSync(path.join(directory, "native.stdout"), compiled.stdout);
  writeFileSync(path.join(directory, "native.stderr"), compiled.stderr);
  const result = runGhdlSynth({ module: wasm, librariesTree, files: [{ path: "top.vhd", content: new TextEncoder().encode(source) }], top: "top", formal, psl });
  writeFileSync(path.join(directory, "wasm.v"), result.verilog);
  writeFileSync(path.join(directory, "wasm.log"), result.log);
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.equal(result.status, 0, result.log);
  assert.equal(result.verilog, compiled.stdout);
  return { native: compiled.stdout, wasm: result.verilog };
}

for (const scenario of [
  { name: "plain-depth3", source: plain, depth: 3, expected: "bounded-safe" },
  { name: "plain-depth4", source: plain, depth: 4, expected: "counterexample" },
  { name: "plain-depth5", source: plain, depth: 5, expected: "counterexample" },
  { name: "plain-negedge", source: counter("  P_BOUND: assert count < 3;", "falling_edge"), depth: 4, edge: "negedge", expected: "counterexample" },
  { name: "plain-prove", source: plain, depth: 12, mode: "prove", expected: "counterexample" },
  { name: "psl-depth3", source: psl, depth: 3, psl: true, expected: "bounded-safe" },
  { name: "psl-depth4", source: psl, depth: 4, psl: true, expected: "counterexample" },
  { name: "psl-depth5", source: psl, depth: 5, psl: true, expected: "counterexample" },
  { name: "psl-activation", source: counter(`  -- psl default clock is rising_edge(clk);
  -- psl P_BOUND: assert always (a = '1' -> next (count < 3));`), depth: 6, psl: true, expected: "counterexample", covers: 1, assumes: 0 },
  { name: "psl-off", source: psl, depth: 5, expected: "error" },
  { name: "psl-inconsistent", source: counter(`  -- psl default clock is rising_edge(clk);
  -- psl A_ONE: assume always (a = '1');
  -- psl A_ZERO: assume always (a = '0');
  -- psl P_BOUND: assert always (count < 3);`), depth: 5, psl: true, expected: "inconsistent-assumptions", covers: 0, assumes: 2 },
]) {
  test(`VHDL property native/WASM ${scenario.name}`, async () => {
    const lowered = lower(scenario.name, scenario.source, { psl: scenario.psl });
    let baseline;
    for (const frontend of ["native", "wasm"]) {
      const execute = createFormalExecutors(evidence, `${scenario.name}-${frontend}`, lowered[frontend]);
      for (const runtime of ["native", "wasm"]) {
        const result = await runSatFormal({ sources: ["top.v"], top: "top", clock: "clk", internalCells: true, ...scenario, execute: execute[runtime] });
        saveResult(path.join(evidence, `${scenario.name}-${frontend}`, `${runtime}-result.json`), result);
        assert.equal(result.status, scenario.expected, `${frontend}/${runtime}: ${result.message}`);
        if (result.inventory) {
          assert.equal(result.inventory.counts.assert, 1);
          if (!baseline) baseline = result.inventory;
          assert.deepEqual(result.inventory, baseline);
          assert.ok(result.inventory.properties.some(({ id, kind, source }) =>
            id === "p_bound" && kind === "assert" && /^top\.vhd:\d+\.\d+-\d+\.\d+$/.test(source)));
          const line = scenario.source.split("\n").findIndex((line) => line.includes("P_BOUND:")) + 1;
          assert.match(result.inventory.properties.find(({ id }) => id === "p_bound").source, new RegExp(`^top\\.vhd:${line}\\.`));
          if (scenario.psl) {
            assert.equal(result.inventory.counts.cover, scenario.covers ?? 1);
            assert.equal(result.inventory.counts.assume, scenario.assumes ?? 1);
            if (scenario.name === "psl-activation") {
              assert.ok(result.inventory.properties.some(({ id, kind }) => id === "p_bound_cover" && kind === "cover"));
            }
          }
          if (result.status === "counterexample") {
            assert.equal(result.replay, "pending");
            const document = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/before.json")));
            const common = createSatReplay({ ...scenario, document, witness: result.witness, top: "top", clock: "clk" });
            const plan = createGhdlReplay(common, { top: "top", psl: scenario.psl ?? false });
            const directory = path.join(evidence, `${scenario.name}-${frontend}`, `${runtime}-original-vhdl`);
            replayOriginal(scenario, frontend, runtime, result.witness, plan, directory);
            if (frontend === "native" && runtime === "native" && scenario.name === "plain-depth4") {
              for (const [phase, mutate] of [
                ["wrong-output", (plan) => { plan.content = plan.content.replace("O top.q 0000", "O top.q 1111"); }],
                ["missing-port", (plan) => { plan.content = plan.content.replaceAll("top.q", "top.missing"); }],
                ["wrong-port-direction", (plan) => { plan.content = plan.content.replaceAll("O top.q", "I top.q"); }],
                ["incomplete-port-inventory", (plan) => { plan.content = plan.content.replace("4 2 0 0", "4 1 0 0").replaceAll(/^I top.a 0\n/gm, ""); }],
                ["malformed-step", (plan) => { plan.content = plan.content.replace("STEP 2", "STEP 3"); }],
                ["duplicate-port", (plan) => { plan.content = plan.content.replaceAll("O top.q", "O top.a"); }],
                ["unknown-input-data", (plan) => { plan.content = plan.content.replace("O top.q 0000", "O top.q XXXX"); }],
                ["extra-input-data", (plan) => { plan.content += "STEP 5\n"; }],
              ]) {
                const invalid = structuredClone(plan);
                mutate(invalid);
                replayOriginal(scenario, frontend, runtime, result.witness, invalid, directory + `-${phase}`, phase);
              }
              for (const [phase, source] of [
                ["mutated-property", scenario.source.replace("count < 3", "count < 15")],
                ["mutated-initial-value", scenario.source.replace("(others => '0')", '"0001"')],
                ["unknown-output", scenario.source.replace("q <= count", "q <= (others => 'X')")],
              ]) replayOriginal({ ...scenario, source }, frontend, runtime, result.witness, plan, directory + `-${phase}`, phase);
            }
            if (frontend === "native" && runtime === "native" && scenario.name === "psl-depth4") {
              const invalid = structuredClone(plan);
              invalid.content = invalid.content.replaceAll("I top.a 0", "I top.a 1");
              replayOriginal(scenario, frontend, runtime, result.witness, invalid, directory + "-violated-assumption", "violated-assumption");
            }
          }
        }
        rows.push([scenario.name, frontend, runtime, scenario.expected, result.status,
          ...["assert", "assume", "cover"].map((kind) => result.inventory?.counts[kind] ?? ""),
          hash(scenario.source), hash(lowered[frontend]), hash(JSON.stringify(result.inventory)),
        ].join(","));
        writeFileSync(path.join(evidence, "results.csv"), `${rows.join("\n")}\n`);
      }
    }
  });
}

test("ordinary GHDL output is opt-out and retains the original assertion diagnostic", () => {
  const result = lower("ordinary", plain, { formal: false });
  assert.match(result.wasm, /\$fatal/);
  assert.doesNotMatch(result.wasm, /\\\$(?:assert|assume|cover)/);
});

test("the actual GHDL module remains compatible without its formal export", () => {
  const bytes = Buffer.from(readFileSync(wasmPath));
  const name = "synth_api__synth_set_formal";
  const position = bytes.indexOf(name);
  assert.ok(position > 0);
  bytes.write("synth_api__synth_set_formaX", position, "ascii");
  const module = new WebAssembly.Module(bytes);
  assert.equal(WebAssembly.Module.exports(module).some((entry) => entry.name === name), false);
  const options = { module, librariesTree, files: [{ path: "top.vhd", content: new TextEncoder().encode(plain) }], top: "top" };
  assert.equal(runGhdlSynth(options).status, 0);
  for (const psl of [false, true]) {
    const result = runGhdlSynth({ ...options, formal: true, psl });
    assert.notEqual(result.status, 0);
    assert.equal(result.stage, "init");
    assert.equal(result.verilog, "");
  }
});

test("malformed PSL fails analysis instead of dropping its property", () => {
  const source = counter(`  -- psl default clock is rising_edge(clk);
  -- psl P_BROKEN: assert always (count < );`);
  const result = runGhdlSynth({ module: wasm, librariesTree, files: [{ path: "broken.vhd", content: new TextEncoder().encode(source) }], top: "top", formal: true, psl: true });
  writeFileSync(path.join(evidence, "malformed-psl.log"), result.log);
  assert.notEqual(result.status, 0);
  assert.equal(result.stage, "analyze");
  assert.equal(result.verilog, "");
  assert.match(result.log, /broken\.vhd:\d+:\d+:/);
});

test("native VHDL evidence audits every CSV column and rejects altered, missing and duplicate rows", () => {
  const preliminary = loadManifest().workingTree !== "";
  const result = auditGhdlReplay(evidence, { preliminary });
  writeFileSync(path.join(evidence, "native-replay-audit.json"), JSON.stringify(result, null, 2));
  const shadow = mkdtempSync(path.join(root, "build/S15/vhdl-replay-audit-negative-"));
  for (const name of readdirSync(evidence).filter((name) => name !== "native-replay.csv")) {
    symlinkSync(path.join(evidence, name), path.join(shadow, name));
  }
  const csv = readFileSync(replayCsv, "utf8");
  const rows = parseReplayCsv(csv);
  const encode = (records) => replayColumns.join(",") + "\n" + records.map((row) => replayColumns.map((name) =>
    `"${row[name].replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
  const mutations = replayColumns.map((name) => rows.map((row, index) => index ? row : { ...row, [name]: "tampered" }));
  mutations.push(rows.slice(1), [...rows, rows[0]]);
  for (const records of mutations) {
    writeFileSync(path.join(shadow, "native-replay.csv"), encode(records));
    assert.throws(() => auditGhdlReplay(shadow, { preliminary }));
  }
  for (const invalid of [csv.trimEnd(), csv.replace(replayColumns.join(","), "case"), csv.replace(/\n$/, ",\n"), csv + "\n"]) {
    assert.throws(() => parseReplayCsv(invalid));
  }
  assert.equal(readFileSync(replayCsv, "utf8"), csv);
});

function loadManifest() { return JSON.parse(readFileSync(path.join(evidence, "manifest.json"), "utf8")); }
