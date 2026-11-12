import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runSatFormal } from "../../web/lib/formal-sat.mjs";
import { createSatReplay, verifySatReplay } from "../../web/lib/formal-replay.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { createMemoryTree, runWasiP1 } from "../../web/lib/wasi-p1.mjs";
import { createFormalExecutors } from "./formal-helpers.mjs";
import { nativeSimulation } from "./iverilog-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
mkdirSync(path.join(root, "build/S15"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/S15/p1-replay-"));
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const nativeDir = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) => [name,
  new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [version, commit] = execFileSync("python3", [".github/scripts/check-pins.py", "iverilog-pin"], { cwd: root, encoding: "utf8" }).trim().split("\t");
const metadata = Object.fromEntries([["native", nativeDir], ["wasm", wasmDir]].map(([runtime, directory]) => {
  const info = JSON.parse(readFileSync(path.resolve(directory, "../build-info.json"), "utf8"));
  assert.equal(info.iverilog.version, version);
  assert.equal(info.iverilog.commit, commit);
  for (const [name, artifact] of Object.entries(info.artifacts)) assert.equal(hash(readFileSync(path.join(directory, name))), artifact.sha256);
  return [runtime, info];
}));
const nativeVersion = spawnSync(path.join(nativeDir, "vvp"), ["-V"], { encoding: "utf8", timeout: 30_000 });
assert.ifError(nativeVersion.error);
assert.equal(nativeVersion.status, 0);
const versionChunks = [];
const wasmVersion = runWasiP1(modules.vvp, {
  args: ["vvp", "-V"], preopens: { "/": createMemoryTree({}) },
  stdout: (bytes) => versionChunks.push(bytes), stderr: (bytes) => versionChunks.push(bytes),
});
assert.equal(wasmVersion.exitCode, 0);
const vvpVersion = `${nativeVersion.stdout}${nativeVersion.stderr}`.trim();
assert.equal(Buffer.concat(versionChunks).toString("utf8").trim(), vvpVersion);
writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version,
  argv: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  iverilog: metadata, vvpVersion,
  hashes: Object.fromEntries([
    "build/native/yosys", "build/wasi/yosys/yosys.wasm",
    ...["ivlpp", "ivl", "vvp"].flatMap((name) => [path.join(nativeDir, name), path.join(wasmDir, `${name}.wasm`)]),
  ].map((name) => [path.relative(root, path.resolve(root, name)), hash(readFileSync(path.resolve(root, name)))])),
}, null, 2));
console.log(`Retained formal replay evidence: ${evidence}`);
const columns = ["case", "origin", "runtime", "phase", "expected", "actual", "exitCode", "steps", "failures", "sourceSha256", "witnessSha256", "scriptSha256", "stdoutSha256", "stderrSha256", "vcdSha256"];
const csv = path.join(evidence, "results.csv");
writeFileSync(csv, columns.join(",") + "\n", { flag: "wx" });
function record(scenario, origin, runtime, phase, replay, execution, verification, witness) {
  const row = {
    case: scenario.name, origin, runtime, phase, expected: phase === "positive" ? "verified" : "rejected",
    actual: verification.status, exitCode: execution.status, steps: replay.steps, failures: verification.failures ?? verification.reason,
    sourceSha256: hash(scenario.source), witnessSha256: hash(JSON.stringify(witness)), scriptSha256: hash(replay.content),
    stdoutSha256: hash(execution.stdout), stderrSha256: hash(execution.stderr), vcdSha256: hash(execution.vcd ?? ""),
  };
  appendFileSync(csv, columns.map((name) => `"${String(typeof row[name] === "object" ? JSON.stringify(row[name]) : row[name]).replaceAll('"', '""')}"`).join(",") + "\n");
}

const counter = `module top(input clk, output reg [3:0] q = 0);
  always @(posedge clk) q <= q + 1'b1;
  always @* begin P_BOUND: assert (q < 4'd3); end
endmodule`;
const scenarios = [
  { name: "depth3", source: counter, depth: 3, clock: "clk", expected: "bounded-safe" },
  { name: "depth4", source: counter, depth: 4, clock: "clk" },
  { name: "depth5", source: counter, depth: 5, clock: "clk" },
  { name: "negedge", source: counter.replace("posedge", "negedge"), depth: 4, clock: "clk", edge: "negedge" },
  { name: "induction-base", source: counter, depth: 12, clock: "clk", mode: "prove" },
  { name: "combinational", source: `module top(input [3:0] a, output [3:0] y);
  assign y = ~a;
\`ifdef FORMAL
  always @* begin P_ID: assert ((a ^ y) == 4'h0); end
\`endif
endmodule`, depth: 4 },
  { name: "reset-sequence", source: `module top(input clk, rst, output reg [3:0] q = 0, output reg started = 0);
  always @(posedge clk) begin started <= 1; if (rst) q <= 0; else q <= q + 1'b1; end
  always @* begin A_RESET: assume (rst == !started); end
  always @* begin P_BOUND: assert (q < 4'd3); end
endmodule`, depth: 5, clock: "clk" },
];

for (const scenario of scenarios) {
  test(`original Verilog independently replays SAT witness: ${scenario.name}`, async () => {
    const execute = createFormalExecutors(evidence, scenario.name, scenario.source);
    for (const runtime of ["native", "wasm"]) {
      const result = await runSatFormal({ sources: ["top.v"], top: "top", ...scenario, execute: execute[runtime] });
      writeFileSync(path.join(evidence, scenario.name, `${runtime}-result.json`), JSON.stringify({
        ...result, observations: result.observations.map(({ files, ...observation }) => ({ ...observation, files: [...files.keys()] })),
      }, null, 2));
      assert.equal(result.status, scenario.expected ?? "counterexample", result.message);
      if (result.status !== "counterexample") continue;
      const document = JSON.parse(new TextDecoder().decode(result.observations[0].files.get("__formal/before.json")));
      const replay = createSatReplay({ ...scenario, top: "top", document, witness: result.witness });
      const files = [{ path: "top.v", content: scenario.source }, { path: replay.path, content: replay.content }];
      const directory = path.join(evidence, scenario.name, `${runtime}-replay`);
      mkdirSync(directory);
      writeFileSync(path.join(directory, "replay.v"), replay.content);
      writeFileSync(path.join(directory, "witness.json"), JSON.stringify(result.witness, null, 2));
      const native = nativeSimulation(directory, files, {
        includeDirectories: [], defines: {}, top: "__formal_replay", formal: true, vcdFile: "formal-replay.vcd",
      });
      const wasm = runIverilog({ modules, files, top: "__formal_replay", formal: true });
      wasm.vcd = wasm.tree?.work?.["formal-replay.vcd"];
      const verified = [native, wasm].map((execution) => verifySatReplay(replay, execution));
      [native, wasm].forEach((execution, index) => record(scenario, runtime, index ? "wasm" : "native", "positive", replay, execution, verified[index], result.witness));
      writeFileSync(path.join(directory, "results.json"), JSON.stringify({
        native: { status: native.status, stdout: native.stdout, stderr: native.stderr },
        wasm: { status: wasm.status, stdout: wasm.stdout, stderr: wasm.stderr }, verified,
      }, null, 2));
      writeFileSync(path.join(directory, "wasm.vcd"), wasm.tree?.work?.["formal-replay.vcd"] ?? "");
      assert.equal(verified[0].status, "verified", JSON.stringify({ native, verified }, null, 2));
      assert.deepEqual(verified[1], verified[0]);
      assert.equal(wasm.status, native.status);
      assert.equal(wasm.stdout, native.stdout);
      assert.equal(wasm.stderr, native.stderr);
      assert.deepEqual(wasm.tree.work["formal-replay.vcd"], new Uint8Array(readFileSync(path.join(directory, "work/formal-replay.vcd"))));
      const broken = structuredClone(result.witness);
      const output = broken.signal.find(({ name }) => name === (scenario.name === "combinational" ? "y" : "q"));
      output.data[0] = "1111";
      const invalidReplay = createSatReplay({ ...scenario, top: "top", document, witness: broken });
      const invalid = runIverilog({ modules, files: [files[0], { path: invalidReplay.path, content: invalidReplay.content }], top: "__formal_replay", formal: true });
      invalid.vcd = invalid.tree?.work?.["formal-replay.vcd"];
      const invalidResult = verifySatReplay(invalidReplay, invalid);
      record(scenario, runtime, "wasm", "wrong-output", invalidReplay, invalid, invalidResult, broken);
      assert.equal(invalidResult.status, "rejected");
      writeFileSync(path.join(directory, "negative-replay.v"), invalidReplay.content);
      writeFileSync(path.join(directory, "negative-witness.json"), JSON.stringify(broken, null, 2));
      writeFileSync(path.join(directory, "negative-wasm.vcd"), invalid.vcd ?? "");
      writeFileSync(path.join(directory, "negative-result.json"), JSON.stringify({
        status: invalid.status, stdout: invalid.stdout, stderr: invalid.stderr,
      }, null, 2));
      if (scenario.name === "reset-sequence") {
        const wrongReset = structuredClone(result.witness);
        const reset = wrongReset.signal.find(({ name }) => name === "rst");
        reset.wave = reset.wave.replace("1", "0");
        const wrongReplay = createSatReplay({ ...scenario, top: "top", document, witness: wrongReset });
        const wrong = runIverilog({ modules, files: [files[0], { path: wrongReplay.path, content: wrongReplay.content }], top: "__formal_replay", formal: true });
        wrong.vcd = wrong.tree?.work?.["formal-replay.vcd"];
        const wrongResult = verifySatReplay(wrongReplay, wrong);
        record(scenario, runtime, "wasm", "wrong-reset", wrongReplay, wrong, wrongResult, wrongReset);
        assert.equal(wrongResult.status, "rejected");
        writeFileSync(path.join(directory, "wrong-reset-replay.v"), wrongReplay.content);
        writeFileSync(path.join(directory, "wrong-reset-witness.json"), JSON.stringify(wrongReset, null, 2));
        writeFileSync(path.join(directory, "wrong-reset-wasm.vcd"), wrong.vcd ?? "");
        writeFileSync(path.join(directory, "wrong-reset-result.json"), JSON.stringify({
          status: wrong.status, stdout: wrong.stdout, stderr: wrong.stderr,
        }, null, 2));
      }
    }
  });
}
