import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { CPU_CASES } from "../fixtures/cpus/cases.mjs";
import { cpuBench } from "../fixtures/cpus/bench.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { prepareLibrarySelection } from "../../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../../web/lib/project-zip.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { assertCpuFrontendFailure, nativeSimulation } from "./iverilog-helpers.mjs";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { orderVhdlFiles, getVhdlLibrary } from "../../web/lib/vhdl-order.mjs";
import { cpuLoweringCommand } from "./library-measurements.mjs";
import { runYosysWasi } from "./nextpnr-helpers.mjs";
import { runNativeYosys } from "./yosys-parity.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const fixtureRoot = path.join(root, "tests/fixtures/cpus");
const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) =>
  [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
const requested = process.env.CPU_SIM_IDS?.split(",");
const cases = requested ? CPU_CASES.filter(({ id }) => requested.includes(id)) : CPU_CASES;
assert.ok(cases.length > 0 && (!requested || new Set(requested).size === cases.length), "Unknown CPU case");

function tree(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const name = path.join(directory, entry.name);
    return [entry.name, entry.isDirectory() ? tree(name) : new Uint8Array(readFileSync(name))];
  }));
}

function synthesizeVhdl(directory, files) {
  const ghdlRoot = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
  const ordered = orderVhdlFiles(files);
  assert.equal(ordered.ok, true, JSON.stringify(ordered));
  const nativeDirectory = path.join(directory, "ghdl-native");
  mkdirSync(nativeDirectory, { recursive: true });
  for (const file of ordered.order) {
    const destination = path.join(nativeDirectory, file.path);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, file.content);
  }
  const nativeBin = path.resolve(root, process.env.GHDL_NATIVE_BIN ?? path.join(ghdlRoot, "ghdl-native/bin/ghdl"));
  const nativeRun = (args) => {
    const result = spawnSync(nativeBin, args, { cwd: nativeDirectory, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    assert.ifError(result.error);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  for (const [index, file] of ordered.order.entries()) {
    const analyzed = nativeRun(["-a", "--std=08", `--work=${getVhdlLibrary(file)}`, file.path]);
    writeFileSync(path.join(nativeDirectory, `analyze-${index}.json`), JSON.stringify(analyzed));
    assert.equal(analyzed.status, 0, analyzed.stderr);
  }
  const native = nativeRun(["--synth", "--std=08", "--out=verilog", "neorv32_bridge"]);
  writeFileSync(path.join(directory, "native-ghdl.json"), JSON.stringify(native));
  assert.equal(native.status, 0, native.stderr);
  const wasm = runGhdlSynth({
    module: new WebAssembly.Module(readFileSync(path.join(ghdlRoot, "ghdl-wasm/ghdl-synth.wasm"))),
    librariesTree: tree(path.join(ghdlRoot, "ghdl-native/lib/ghdl")),
    files: ordered.order, top: "neorv32_bridge", standard: "2008",
  });
  writeFileSync(path.join(directory, "wasm-ghdl.log"), wasm.log);
  writeFileSync(path.join(directory, "wasm-ghdl.v"), wasm.verilog ?? "");
  assert.equal(wasm.status, 0, wasm.log);
  assert.equal(wasm.verilog, native.stdout);
  return { path: "src/neorv32-generated.v", content: wasm.verilog };
}

test("CPU lowering preserves observation-only request signals without changing upstream RTL", () => {
  const directory = mkdtempSync(path.join(root, "build/t5-cpu-observation-"));
  const source = "module top(input clk,output reg led=0); wire i_req=led^clk; wire i_ack=i_req; always@(posedge clk)led<=!led; endmodule";
  const keepCommand = "setattr -set keep 1 top/w:i_req top/w:i_ack; ";
  try {
    for (const keep of [false, true]) {
      const workdir = path.join(directory, keep ? "retained" : "negative-removed");
      for (const part of ["src", "tmp"]) mkdirSync(path.join(workdir, part), { recursive: true });
      let command = cpuLoweringCommand("read_verilog src/top.v");
      assert.ok(command.includes(keepCommand));
      if (!keep) command = command.replace(keepCommand, "");
      runYosysWasi(workdir, source, command);
      runNativeYosys(workdir, command.replace("src/lowered.v", "src/native-lowered.v").replace("write_json top.json", "write_json native-top.json"));
      const wasm = JSON.parse(readFileSync(path.join(workdir, "top.json"), "utf8"));
      const native = JSON.parse(readFileSync(path.join(workdir, "native-top.json"), "utf8"));
      assert.deepEqual(wasm.modules, native.modules);
      for (const name of ["i_req", "i_ack"]) {
        assert.equal(Object.hasOwn(wasm.modules.top.netnames, name), keep);
        const verilog = readFileSync(path.join(workdir, "src/lowered.v"), "utf8");
        assert.equal(new RegExp(`\\bwire ${name};`).test(verilog), keep);
      }
    }
  } catch (error) {
    console.error(`Retained CPU observer evidence: ${directory}`);
    throw error;
  }
});

test("pinned CPU programs execute RAM and GPIO checks after portable ZIP import", async (t) => {
  const keep = process.env.CPU_SIM_EVIDENCE !== undefined;
  const directory = keep ? path.resolve(root, process.env.CPU_SIM_EVIDENCE) : mkdtempSync(path.join(root, "build/t5-cpu-simulation-"));
  if (keep) mkdirSync(directory);
  const suppliedAssets = process.env.CPU_LIBRARY_ASSETS;
  const assets = suppliedAssets ? path.resolve(root, suppliedAssets) : path.join(directory, "assets");
  let passed = 0;
  let frontendUnsupported = 0;
  try {
    if (!suppliedAssets) {
      const built = spawnSync("python3", ["scripts/build-library-assets.py", "--output", assets], { cwd: root, encoding: "utf8" });
      assert.equal(built.status, 0, `${built.stderr}\n${built.error ?? ""}`);
    }
    const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
    for (const { id, component, language, fixture, frontendFailure } of cases) {
      await t.test(id, async () => {
        const added = await prepareLibrarySelection(catalog, { id, component },
          (asset) => readFileSync(path.join(assets, asset.asset)), { requireConfirmed: false });
        const template = createBlinkTemplate("tangnano20k", "verilog");
        template.files.set("src/top_tb.v", cpuBench());
        template.project.simulation.top = "tb";
        template.project.simulation.files = null;
        template.files.set("src/top.v", readFileSync(path.join(fixtureRoot, fixture)));
        if (language === "vhdl") {
          template.files.set("src/neorv32.vhd", readFileSync(path.join(fixtureRoot, "neorv32.vhd")));
        }
        for (const name of ["memory.v", "bus.vh", "program.hex"]) {
          template.files.set(`src/${name}`, readFileSync(path.join(fixtureRoot, name)));
        }
        template.project.files = [...template.files.keys()].map((path) => ({ path }));
        const installed = await changeProjectLibraries(template.project, template.files, { add: added });
        const zip = await exportProjectZip(installed.project, installed.files);
        writeFileSync(path.join(directory, `${id}.zip`), zip);
        const restored = await importProjectZip(zip);
        const input = await prepareProjectInputs(restored.project, restored.files);
        let sources = input.files.filter((file) => /\.(?:v|vh|hex)$/.test(file.path));
        if (language === "vhdl") {
          sources = [...sources, synthesizeVhdl(path.join(directory, id), input.files.filter((file) => file.role !== "data" && /\.(vhd|vhdl)$/i.test(file.path)))];
        }
        if (frontendFailure) {
          const workdir = path.join(directory, id, "frontend-unsupported");
          mkdirSync(workdir, { recursive: true });
          assertCpuFrontendFailure(workdir, [...sources, { path: "src/tb.v", content: cpuBench() }], input, modules, frontendFailure);
          frontendUnsupported += 1;
          return;
        }
        const controls = [
          { name: "positive", status: 0, marker: /CPU_FUNCTION_OK writes=16 stores=16 reads=16 samples=2/ },
          { name: "program-corrupted", status: 1, marker: /CPU_MEMORY_WRITE/ },
          { name: "reset-held", status: 1, marker: /CPU_TIMEOUT/, resetHeld: true },
          { name: "wrong-expectation", status: 1, marker: /CPU_GPIO_MISMATCH/, wrongExpected: true },
          { name: "sample-stuck", status: 1, marker: /CPU_SAMPLE_STATIC/, sampleHeld: true },
          { name: "led-stuck", status: 1, marker: /CPU_GPIO_OUTPUT/, ledHeld: true },
        ];
        for (const control of controls) {
          const files = [...sources, { path: "src/tb.v", content: cpuBench(control) }].map((file) => ({ ...file }));
          if (control.name === "program-corrupted") {
            const rom = files.find((file) => file.path === "src/program.hex");
            assert.ok(rom);
            const words = new TextDecoder().decode(rom.content).trim().split("\n");
            assert.equal(words[5], "0551c313");
            words[5] = "0541c313";
            rom.content = new TextEncoder().encode(`${words.join("\n")}\n`);
          }
          const workdir = path.join(directory, id, control.name);
          mkdirSync(workdir, { recursive: true });
          const native = nativeSimulation(workdir, files, input);
          const wasm = runIverilog({
            modules, files, top: "tb", sourceFiles: files.filter((file) => /\.v$/i.test(file.path)).map((file) => file.path),
            includeDirs: ["src", ...input.includeDirectories], defines: input.defines,
          });
          writeFileSync(path.join(workdir, "results.json"), JSON.stringify({
            native: { status: native.status, stdout: native.stdout, stderr: native.stderr },
            wasm: { status: wasm.status, stdout: wasm.stdout, stderr: wasm.stderr },
          }, null, 2));
          if (wasm.tree?.work?.["wave.vcd"]) writeFileSync(path.join(workdir, "wasm.vcd"), wasm.tree.work["wave.vcd"]);
          assert.equal(native.status, control.status, `${native.stdout}\n${native.stderr}`);
          assert.equal(wasm.status, native.status, `${wasm.stdout}\n${wasm.stderr}`);
          assert.equal(wasm.stdout, native.stdout);
          assert.match(wasm.stdout, control.marker);
          assert.ok(native.vcd, "Native Icarus produced no VCD");
          assert.deepEqual(Buffer.from(wasm.tree.work["wave.vcd"]), native.vcd);
          if (control.status) assert.doesNotMatch(wasm.stdout, /CPU_FUNCTION_OK/);
        }
        passed += 1;
      });
    }
  } finally {
    writeFileSync(path.join(directory, "summary.json"), JSON.stringify({ passed, frontend_unsupported: frontendUnsupported, expected: cases.length }, null, 2), { flag: "wx" });
    if (passed + frontendUnsupported === cases.length && !keep) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained CPU functional evidence: ${directory}`);
  }
});
