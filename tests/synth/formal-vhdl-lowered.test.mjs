import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import test, { after } from "node:test";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { runSatFormal } from "../../web/lib/formal-sat.mjs";
import { createSatReplay, verifySatReplay } from "../../web/lib/formal-replay.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { createFormalExecutors } from "./formal-helpers.mjs";
import { buildGhdlReplayPlugin, createGhdlReplay, runGhdlReplay, verifyGhdlReplay } from "./ghdl-replay-helpers.mjs";
import { bindLoweredProperties } from "./ghdl-lowered-replay.mjs";
import { nativeSimulation } from "./iverilog-helpers.mjs";
import { auditLoweredReplay, inspectLoweredReplay, serializeLoweredCsv, validateLoweredCsv, evidenceFiles } from "../../scripts/audit-lowered-replay.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const build = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
const native = path.join(build, "ghdl-native/bin/ghdl");
const ghdlPath = path.join(build, "ghdl-wasm/ghdl-synth.wasm");
const ghdl = new WebAssembly.Module(readFileSync(ghdlPath));
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) =>
  [name, new WebAssembly.Module(readFileSync(path.join(root, "build/iverilog-wasm/output", `${name}.wasm`)))]));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = (file, value) => writeFileSync(file, JSON.stringify(value, (key, item) =>
  item instanceof Map ? Object.fromEntries(item) : item instanceof Uint8Array ? { sha256: hash(item), size: item.length } : item, 2));
function loadTree(directory) {
  return Object.fromEntries(readdirSync(directory).map((name) => {
    const file = path.join(directory, name);
    return [name, statSync(file).isDirectory() ? loadTree(file) : new Uint8Array(readFileSync(file))];
  }));
}
const librariesTree = loadTree(path.join(build, "ghdl-native/lib/ghdl"));
mkdirSync(path.join(root, "build/S15"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/S15/p1-vhdl-lowered-"));
console.log(`Retained VHDL lowered replay evidence: ${evidence}`);
const metadata = Object.fromEntries(readFileSync(path.join(build, "ghdl-wasm/build-manifest.tsv"), "utf8").trim().split("\n").map((row) => row.split("\t")));
assert.equal(hash(readFileSync(native)), metadata.native_sha256);
for (const file of ["patches/ghdl/formal-verilog.patch", "patches/ghdl/formal-verilog-driver.patch", "scripts/ghdl-wasm/synth_api.ads", "scripts/ghdl-wasm/synth_api.adb"]) {
  assert.equal(hash(readFileSync(path.join(root, file))), metadata[`source_sha256:${file}`]);
}
assert.equal(hash(readFileSync(ghdlPath)), readFileSync(path.join(build, "ghdl-wasm/SHA256SUMS"), "utf8").split(/\s+/)[0]);
const plugin = buildGhdlReplayPlugin(native, path.join(evidence, "native-replay-plugin"));
const binaries = [native, ghdlPath, plugin, "build/native/yosys", "build/wasi/yosys/yosys.wasm",
  ...["ivlpp", "ivl", "vvp"].flatMap((name) => [`build/iverilog-native/output/${name}`, `build/iverilog-wasm/output/${name}.wasm`])];
const sources = ["scripts/audit-lowered-replay.mjs", "tests/synth/formal-vhdl-lowered.test.mjs", "tests/synth/ghdl-lowered-replay.mjs",
  "tests/synth/ghdl-replay-helpers.mjs", "tests/synth/ghdl-replay-vcd.mjs", "tests/synth/ghdl-replay-vpi.c", "tests/synth/formal-helpers.mjs", "tests/synth/iverilog-helpers.mjs",
  "web/lib/formal-sat.mjs", "web/lib/formal-replay.mjs", "web/lib/formal-properties.mjs", "web/lib/ghdl-host.mjs", "web/lib/iverilog-host.mjs", "web/lib/wasi-p1.mjs"];
const manifest = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version, ghdlVersion: execFileSync(native, ["--version"], { encoding: "utf8" }),
  compiler: execFileSync("gcc", ["--version"], { encoding: "utf8" }), buildManifest: metadata,
  command: process.argv, nodeArguments: process.execArgv,
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), cpus: os.cpus().map(({ model }) => model), memoryBytes: os.totalmem(), osRelease: readFileSync("/etc/os-release", "utf8") },
  submodules: execFileSync("git", ["submodule", "status", "--recursive"], { cwd: root, encoding: "utf8" }),
  yosysVersion: execFileSync(path.join(root, "build/native/yosys"), ["-V"], { encoding: "utf8" }),
  vvpVersion: (() => { const result = spawnSync(path.join(root, "build/iverilog-native/output/vvp"), ["-V"], { encoding: "utf8" });
    assert.ifError(result.error); assert.equal(result.status, 0); return result.stdout + result.stderr; })(),
  hashes: Object.fromEntries([...binaries, ...sources].map((file) => [path.relative(root, path.resolve(root, file)), hash(readFileSync(path.resolve(root, file)))])),
};
json(path.join(evidence, "manifest.json"), manifest);
after(() => {
  const rows = inspectLoweredReplay(evidence);
  const csv = serializeLoweredCsv(rows);
  writeFileSync(path.join(evidence, "lowered-replay.csv"), csv, { flag: "wx" });
  manifest.files = Object.fromEntries(evidenceFiles(evidence).filter((file) => file !== "manifest.json").map((file) => [file, hash(readFileSync(path.join(evidence, file)))]));
  json(path.join(evidence, "manifest.json"), manifest);
  auditLoweredReplay(evidence, { preliminary: manifest.workingTree !== "" });
  for (const column of Object.keys(rows[0])) {
    const changed = structuredClone(rows);
    changed[0][column] += "tampered";
    assert.throws(() => validateLoweredCsv(serializeLoweredCsv(changed), rows));
  }
  for (const changed of [rows.slice(1), [...rows, rows[0]]]) assert.throws(() => validateLoweredCsv(serializeLoweredCsv(changed), rows));
  assert.throws(() => validateLoweredCsv(csv.slice(0, -1), rows));
});

function lower(scenario) {
  const directory = path.join(evidence, scenario.name);
  mkdirSync(directory);
  writeFileSync(path.join(directory, "top.vhd"), scenario.source);
  const files = [...(scenario.dependencies ?? []), { path: "top.vhd", content: new TextEncoder().encode(scenario.source) }];
  for (const [index, file] of files.entries()) {
    assert.equal(path.basename(file.path), file.path);
    writeFileSync(path.join(directory, file.path), file.content);
    const args = ["-a", "--std=08", ...(scenario.psl ? ["-fpsl"] : []), `--work=${file.library ?? "work"}`, file.path];
    const result = spawnSync(native, args, { cwd: directory, encoding: "utf8", timeout: 30_000 });
    json(path.join(directory, `analyze-${index}.json`), { args, status: result.status, signal: result.signal, error: result.error?.message ?? null });
    writeFileSync(path.join(directory, `analyze-${index}.stdout`), result.stdout ?? "");
    writeFileSync(path.join(directory, `analyze-${index}.stderr`), result.stderr ?? "");
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
  const args = ["--synth", "--std=08", "--out=verilog", "--formal-verilog", ...(scenario.psl ? ["-fpsl"] : []), "top"];
  json(path.join(directory, "native-command.json"), { args, cwd: directory });
  const compiled = spawnSync(native, args, { cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  writeFileSync(path.join(directory, "native.v"), compiled.stdout ?? "");
  writeFileSync(path.join(directory, "native.stderr"), compiled.stderr ?? "");
  json(path.join(directory, "native-execution.json"), { status: compiled.status, signal: compiled.signal, error: compiled.error?.message ?? null });
  assert.ifError(compiled.error);
  assert.equal(compiled.status, 0, compiled.stderr);
  const synthesized = runGhdlSynth({ module: ghdl, librariesTree, files,
    top: "top", formal: true, psl: scenario.psl ?? false });
  writeFileSync(path.join(directory, "wasm.v"), synthesized.verilog);
  writeFileSync(path.join(directory, "wasm.log"), synthesized.log);
  assert.equal(synthesized.status, 0, synthesized.log);
  assert.equal(synthesized.verilog, compiled.stdout);
  return { native: compiled.stdout, wasm: synthesized.verilog };
}

const counter = (property, { edge = "rising_edge", initial = "0000", reset = false } = {}) => `library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk : in std_logic; a : in std_logic; ${reset ? "rst : in std_logic; " : ""}q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
  signal count : unsigned(3 downto 0) := "${initial}";
begin
  process(clk) begin
    if ${edge}(clk) then ${reset ? "if rst = '1' then count <= (others => '0'); else " : ""}count <= count + 1; ${reset ? "end if; " : ""}end if;
  end process;
  q <= count;
${property}
end architecture;
`;
const plain = "  P_BOUND: assert count < 3;";
function firstFailures(failures) {
  const first = new Map();
  for (const failure of [...failures].sort((a, b) => a.step - b.step)) {
    if (!first.has(failure.id)) first.set(failure.id, failure);
  }
  return [...first.values()].sort((a, b) => a.id.localeCompare(b.id));
}
const scenarios = [
  { name: "plain-depth4", source: counter(plain), depth: 4 },
  { name: "plain-depth5", source: counter(plain), depth: 5 },
  { name: "plain-negedge", source: counter(plain, { edge: "falling_edge" }), depth: 4, edge: "negedge" },
  { name: "initial-nonzero", source: counter(plain, { initial: "0001" }), depth: 4 },
  { name: "synchronous-reset", source: counter(plain, { reset: true }), depth: 5 },
  { name: "multiple-properties", source: counter(`${plain}\n  P_EARLIER: assert count < 2;`), depth: 5 },
  { name: "named-library", source: counter(plain).replace("architecture rtl of top is", "library arithmetic;\nuse arithmetic.operations.all;\narchitecture rtl of top is")
    .replace("count + 1", "bump(count)"), depth: 4, dependencies: [{ path: "operations.vhd", library: "arithmetic", content: `library ieee;
use ieee.numeric_std.all;
package operations is
  function bump(value : unsigned) return unsigned;
end package;
package body operations is
  function bump(value : unsigned) return unsigned is
  begin
    return value + 1;
  end function;
end package body;
` }] },
  { name: "hierarchy", source: counter(" ").replaceAll(/\btop\b/g, "leaf") + `
library ieee;
use ieee.std_logic_1164.all;
use ieee.numeric_std.all;
entity top is
  port (clk : in std_logic; a : in std_logic; q : out unsigned(3 downto 0));
end entity;
architecture rtl of top is
begin
  u: entity work.leaf port map (clk => clk, a => a, q => q);
  P_BOUND: assert not (q(0) = '1' and q(1) = '1');
end architecture;
`, depth: 4 },
  { name: "psl-depth4", source: counter(`  -- psl default clock is rising_edge(clk);
  -- psl A_INPUT: assume always (a = '0');
  -- psl C_REACH: cover {count = 2};
  -- psl P_BOUND: assert always (count < 3);`), depth: 4, psl: true },
  { name: "psl-activation", source: counter(`  -- psl default clock is rising_edge(clk);
  -- psl P_BOUND: assert always (a = '1' -> next (count < 3));`), depth: 6, psl: true },
];

for (const scenario of scenarios) test(`original VHDL and lowered Icarus agree: ${scenario.name}`, async () => {
  const lowered = lower(scenario);
  let baseline;
  for (const frontend of ["native", "wasm"]) {
    const name = `${scenario.name}-${frontend}`;
    const execute = createFormalExecutors(evidence, name, lowered[frontend]);
    for (const runtime of ["native", "wasm"]) {
      const result = await runSatFormal({ ...scenario, sources: ["top.v"], top: "top", clock: "clk", internalCells: true, execute: execute[runtime] });
      json(path.join(evidence, name, `${runtime}-result.json`), result);
      assert.equal(result.status, "counterexample", `${frontend}/${runtime}: ${result.message}`);
      const document = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/before.json")));
      const preparedDocument = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/after.json")));
      const common = createSatReplay({ ...scenario, document, witness: result.witness, top: "top", clock: "clk" });
      const originalPlan = createGhdlReplay(common, { top: "top", psl: scenario.psl ?? false, document });
      const originalDirectory = path.join(evidence, name, `${runtime}-original-vhdl`);
      const originalExecution = runGhdlReplay({ native, plugin, directory: originalDirectory, source: scenario.source, plan: originalPlan, dependencies: scenario.dependencies });
      const originalVerification = verifyGhdlReplay(originalPlan, originalExecution);
      json(path.join(originalDirectory, "plan.json"), originalPlan);
      json(path.join(originalDirectory, "verification.json"), originalVerification);
      json(path.join(originalDirectory, "witness.json"), result.witness);
      json(path.join(originalDirectory, "execution.json"), { status: originalExecution.status, signal: originalExecution.signal, error: originalExecution.error, elapsedMs: originalExecution.elapsedMs });
      assert.equal(originalVerification.status, "verified", originalVerification.reason);
      const emitted = await execute[runtime]({ phase: "emit", script: "read_rtlil __formal/prepared.il; chformal -cover -remove; write_verilog __formal/replay-design.v" });
      assert.equal(emitted.exitCode, 0, emitted.stderr);
      const source = "`timescale 1ns/1ps\n" + new TextDecoder("utf-8", { fatal: true }).decode(emitted.files.get("__formal/replay-design.v"));
      const inspectName = `${name}-${runtime}-emitted`;
      const inspect = createFormalExecutors(evidence, inspectName, source);
      const inspected = await inspect[runtime]({ phase: "inspect", script: "read_verilog -formal top.v; hierarchy -check -top top; proc; flatten; chformal -lower; write_json __formal/before.json" });
      assert.equal(inspected.exitCode, 0, inspected.stderr);
      const emittedDocument = JSON.parse(new TextDecoder().decode(inspected.files.get("__formal/before.json")));
      const plan = bindLoweredProperties(common, preparedDocument, emittedDocument, { ...scenario, top: "top", clock: "clk" });
      const simulationDirectory = path.join(evidence, inspectName, "replay");
      mkdirSync(simulationDirectory);
      json(path.join(simulationDirectory, "plan.json"), plan);
      json(path.join(simulationDirectory, "document.json"), preparedDocument);
      json(path.join(simulationDirectory, "source-document.json"), document);
      json(path.join(simulationDirectory, "emitted-document.json"), emittedDocument);
      json(path.join(simulationDirectory, "common-plan.json"), common);
      json(path.join(simulationDirectory, "original-failures.json"), originalVerification.failures);
      const files = [{ path: "top.v", content: source }, { path: plan.path, content: plan.content }];
      let started = performance.now();
      const nativeExecution = nativeSimulation(path.join(simulationDirectory, "native"), files,
        { includeDirectories: [], defines: {}, top: "__formal_replay", formal: true, vcdFile: "formal-replay.vcd" });
      nativeExecution.elapsedMs = performance.now() - started;
      started = performance.now();
      const wasmExecution = runIverilog({ modules, files, top: "__formal_replay", formal: true });
      wasmExecution.elapsedMs = performance.now() - started;
      wasmExecution.vcd = wasmExecution.tree?.work?.["formal-replay.vcd"];
      for (const [replayRuntime, execution] of Object.entries({ native: nativeExecution, wasm: wasmExecution })) {
        writeFileSync(path.join(simulationDirectory, `${replayRuntime}.stdout`), execution.stdout);
        writeFileSync(path.join(simulationDirectory, `${replayRuntime}.stderr`), execution.stderr);
        writeFileSync(path.join(simulationDirectory, `${replayRuntime}.vcd`), execution.vcd ?? "");
        const verification = verifySatReplay(plan, execution);
        json(path.join(simulationDirectory, `${replayRuntime}-verification.json`), verification);
        json(path.join(simulationDirectory, `${replayRuntime}-execution.json`), { status: execution.status, signal: execution.signal ?? null, error: execution.error ?? null, elapsedMs: execution.elapsedMs });
        assert.equal(verification.status, "verified", verification.reason);
        assert.deepEqual(firstFailures(verification.failures), firstFailures(originalVerification.failures));
        for (const failure of verification.failures) assert.ok(originalVerification.failures.some((original) =>
          original.id === failure.id && original.step === failure.step && original.source === failure.source));
        if (!baseline) baseline = firstFailures(verification.failures);
        assert.deepEqual(firstFailures(verification.failures), baseline);
      }
      assert.equal(wasmExecution.stdout, nativeExecution.stdout);
      assert.equal(wasmExecution.stderr, nativeExecution.stderr);
      assert.deepEqual(Buffer.from(wasmExecution.vcd), nativeExecution.vcd);
      const changed = structuredClone(plan);
      changed.content = changed.content.replace(/(p\d+ !== 4'b)([01]{4})/, (_match, prefix, bits) =>
        prefix + (bits[0] === "0" ? "1" : "0") + bits.slice(1));
      assert.notEqual(changed.content, plan.content);
      const negative = runIverilog({ modules, files: [{ path: "top.v", content: source }, { path: plan.path, content: changed.content }],
        top: "__formal_replay", formal: true });
      negative.vcd = negative.tree?.work?.["formal-replay.vcd"];
      writeFileSync(path.join(simulationDirectory, "wrong-output.stdout"), negative.stdout);
      writeFileSync(path.join(simulationDirectory, "wrong-output.stderr"), negative.stderr);
      writeFileSync(path.join(simulationDirectory, "wrong-output.vcd"), negative.vcd ?? "");
      const rejection = verifySatReplay(changed, negative);
      json(path.join(simulationDirectory, "wrong-output-verification.json"), rejection);
      json(path.join(simulationDirectory, "wrong-output-plan.json"), changed);
      json(path.join(simulationDirectory, "wrong-output-execution.json"), { status: negative.status, signal: negative.signal ?? null, error: negative.error ?? null });
      assert.equal(rejection.status, "rejected");
      assert.match(rejection.reason, /normally|Mismatch|FATAL/);
    }
  }
});

const excluded = [
  { name: "unknown-initial", source: counter(plain, { initial: "XXXX" }), depth: 4,
    status: "counterexample", replayError: /concrete register initialization/ },
  { name: "unconstrained-initial", source: counter(plain).replace(' := "0000"', ""), depth: 4,
    status: "counterexample", replayError: /unconstrained initial state/ },
  { name: "combinational-loop", source: counter("  P_LOOP: assert ring = '1';")
    .replace("  signal count", "  signal ring : std_logic;\n  signal count").replace("  q <= count;", "  ring <= not ring;\n  q <= count;"), depth: 4,
    status: "error", message: /preparation failed/ },
  { name: "memory", source: counter(plain)
    .replace("  signal count", "  type memory_type is array (0 to 15) of unsigned(3 downto 0);\n  signal ram : memory_type := (others => (others => '0'));\n  signal count")
    .replace("  q <= count;", "  process(clk) begin\n    if rising_edge(clk) then ram(to_integer(count)) <= count; end if;\n  end process;\n  q <= ram(to_integer(count));"), depth: 4,
    status: "error", message: /Unsupported formal state cell: \$mem/ },
  { name: "vacuous-activation", source: counter(`  -- psl default clock is rising_edge(clk);
  -- psl A_INPUT: assume always (a = '0');
  -- psl P_BOUND: assert always (a = '1' -> next (count < 3));`), psl: true, depth: 6,
    status: "bounded-safe" },
];
for (const scenario of excluded) test(`VHDL fixture retains its explicit boundary: ${scenario.name}`, async () => {
  const lowered = lower(scenario);
  for (const frontend of ["native", "wasm"]) {
    const name = `${scenario.name}-${frontend}`;
    const execute = createFormalExecutors(evidence, name, lowered[frontend]);
    for (const runtime of ["native", "wasm"]) {
      const result = await runSatFormal({ ...scenario, sources: ["top.v"], top: "top", clock: "clk", internalCells: true, execute: execute[runtime] });
      json(path.join(evidence, name, `${runtime}-result.json`), result);
      assert.equal(result.status, scenario.status, result.message);
      if (scenario.message) assert.match(result.message, scenario.message);
      if (scenario.replayError) {
        const document = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/before.json")));
        assert.throws(() => createSatReplay({ ...scenario, document, witness: result.witness, top: "top", clock: "clk" }), scenario.replayError);
      }
      if (scenario.name === "vacuous-activation") assert.ok(result.inventory.properties.some(({ id, kind }) => id === "p_bound_cover" && kind === "cover"));
    }
  }
});
