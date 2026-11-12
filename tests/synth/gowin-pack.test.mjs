import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { loadPyodide } from "pyodide";
import { BOARDS, gowinSynthesisCommand } from "../../web/lib/boards.mjs";
import { createBlinkTemplate, generateCst } from "../../web/lib/templates.mjs";
import { prepareLibrarySelection, verilogReadCommand } from "../../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../../web/lib/project-zip.mjs";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { orderVhdlFiles } from "../../web/lib/vhdl-order.mjs";
import { HDL_LIBRARY_CASES } from "../fixtures/libraries/cases.mjs";
import { CPU_CASES } from "../fixtures/cpus/cases.mjs";
import { cpuBench } from "../fixtures/cpus/bench.mjs";
import { assertCpuFrontendFailure, nativeSimulation } from "./iverilog-helpers.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { assertYosysParity, runNativeYosys } from "./yosys-parity.mjs";
import { cpuLoweringCommand, executionErrorDetails, inspectCpuStructure, isCapacityExceeded, parseDeviceUtilization } from "./library-measurements.mjs";
import { fsIdcode, fsIdcodeMatchesBoard } from "../../web/lib/fs-idcode.mjs";
import {
  prepareGowinPackRuntime,
  runGowinPack,
} from "../../web/lib/gowin-pack.mjs";
import {
  createWorkdir,
  nextpnrWasmPath,
  pnrArgs,
  runNative,
  runWasi,
  runYosysWasi,
} from "./nextpnr-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const packRoot = path.join(root, "build/pack");
const indexURL = pathToFileURL(`${packRoot}/pyodide/`).href;
const apyculaWheel = readdirSync(path.join(packRoot, "wheels")).find((file) =>
  file.startsWith("apycula-"),
);
assert.ok(apyculaWheel, "Pinned Apicula wheel is missing from build/pack/wheels");
const apyculaWheelURL = pathToFileURL(path.join(packRoot, "wheels", apyculaWheel)).href;
const nativePackPath = path.join(root, "build/deps/apycula-venv/bin/gowin_pack");
const nativePythonPath = path.join(root, "build/deps/apycula-venv/bin/python");
const pyodideLoader = (options) => loadPyodide(options);
const routedByBoard = new Map();
let pyodideSetupMs = 0;

assert.ok(existsSync(nextpnrWasmPath), `WASI nextpnr is missing: ${nextpnrWasmPath}`);
assert.ok(existsSync(nativePackPath), `Native gowin_pack is missing: ${nativePackPath}`);
assert.ok(existsSync(path.join(packRoot, "wheels", apyculaWheel)));

before(async () => {
  const started = performance.now();
  await prepareGowinPackRuntime({
    loadPyodide: pyodideLoader,
    indexURL,
    apyculaWheelURL,
  });
  pyodideSetupMs = performance.now() - started;
  const versions = spawnSync(
    nativePythonPath,
    ["-c", "import msgspec, numpy; print(f'numpy={numpy.__version__} msgspec={msgspec.__version__}')"],
    { encoding: "utf8" },
  );
  assert.equal(versions.status, 0, `Could not read native dependency versions:\n${versions.stderr}`);
  console.log(
    `Pyodide 314.0.7/Python 3.14.2 setup ${pyodideSetupMs.toFixed(1)} ms; ` +
      `native ${versions.stdout.trim()}; nextpnr WASM ${statSync(nextpnrWasmPath).size} bytes`,
  );
});

function createDiffSummary(expected, actual) {
  const nativeText = new TextDecoder().decode(expected);
  const pyodideText = new TextDecoder().decode(actual);
  let offset = 0;
  while (
    offset < expected.length &&
    offset < actual.length &&
    expected[offset] === actual[offset]
  ) {
    offset += 1;
  }
  const nativeLine = nativeText.slice(0, offset).split("\n").length;
  const snippet = (text) => JSON.stringify(text.slice(Math.max(0, offset - 24), offset + 48));
  return (
    `first byte difference at offset ${offset}, line ${nativeLine}; ` +
    `native=${snippet(nativeText)}; Pyodide=${snippet(pyodideText)}; ` +
    `sizes native=${expected.length}, Pyodide=${actual.length}`
  );
}

function runNativePack(board, routedJson, workdir) {
  writeFileSync(path.join(workdir, "top.json"), routedJson);
  const started = performance.now();
  const result = spawnSync(
    nativePackPath,
    ["-d", board.packDevice, "-o", "top.fs", "top.json"],
    { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    `Native gowin_pack failed for ${board.id}:\n${result.stderr ?? ""}\n${result.error ?? ""}`,
  );
  const output = readFileSync(path.join(workdir, "top.fs"));
  assert.ok(output.length > 0, `Native gowin_pack produced an empty .fs for ${board.id}`);
  return { output, stderr: result.stderr ?? "", elapsed: performance.now() - started };
}

function assertBoardIdcode(bytes, board) {
  const idcode = fsIdcode(new TextDecoder().decode(bytes));
  assert.notEqual(idcode, null, `Could not read IDCODE for ${board.id}`);
  assert.ok(
    fsIdcodeMatchesBoard(idcode, board),
    `IDCODE 0x${idcode.toString(16)} does not match ${board.id}`,
  );
}

function assertTimescalePreservesBitstream(board, source, expectedFs) {
  const directive = "`timescale 1ns/1ps\n";
  assert.ok(source.startsWith(directive), "The simulation template must specify its timescale");
  const workdir = createWorkdir("gowin-pack-before-timescale-");
  try {
    runYosysWasi(workdir, source.slice(directive.length));
    writeFileSync(path.join(workdir, "constraints/board.cst"), generateCst(board.id));
    const pnr = runWasi(workdir, pnrArgs(board));
    assert.equal(pnr.status, 0, `Baseline nextpnr failed for ${board.id}:\n${pnr.stderr}`);
    const routedJson = readFileSync(path.join(workdir, "pnr.json"));
    const { output } = runNativePack(board, routedJson, workdir);
    assert.deepStrictEqual(output, expectedFs, `The timescale changed the .fs for ${board.id}`);
    console.log(`${board.id}: before/after timescale .fs SHA-256 ${createHash("sha256").update(output).digest("hex")}`);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

for (const board of BOARDS) {
  test(`Pyodide gowin_pack matches native for ${board.id}`, async () => {
    const workdir = createWorkdir("gowin-pack-test-");
    try {
      const { files } = createBlinkTemplate(board.id, "verilog");
      const source = files.get("src/top.v");
      assert.equal(typeof source, "string", `Verilog template is missing for ${board.id}`);
      runYosysWasi(workdir, source);
      writeFileSync(path.join(workdir, "constraints/board.cst"), generateCst(board.id));
      const pnr = runWasi(workdir, pnrArgs(board));
      assert.equal(pnr.status, 0, `WASI nextpnr failed for ${board.id}:\n${pnr.stderr}`);
      const routedJson = readFileSync(path.join(workdir, "pnr.json"));
      routedByBoard.set(board.id, routedJson);

      const nativeWorkdir = createWorkdir("gowin-pack-native-");
      try {
        const { output: nativeFs, elapsed: nativeElapsed } = runNativePack(board, routedJson, nativeWorkdir);
        assertBoardIdcode(nativeFs, board);
        assertTimescalePreservesBitstream(board, source, nativeFs);
        const packTimes = [];
        let fallbackWarning = "";
        for (let repeat = 0; repeat < 5; repeat += 1) {
          const started = performance.now();
          const packed = await runGowinPack({
            loadPyodide: pyodideLoader,
            indexURL,
            apyculaWheelURL,
            netlistJson: routedJson,
            device: board.packDevice,
          });
          packTimes.push(performance.now() - started);
          fallbackWarning += packed.stderr;
          assert.deepStrictEqual(
            Buffer.from(packed.fs),
            nativeFs,
            `Native/Pyodide .fs differ for ${board.id}: ${createDiffSummary(nativeFs, packed.fs)}`,
          );
          assertBoardIdcode(packed.fs, board);
        }
        const sorted = [...packTimes].sort((left, right) => left - right);
        console.log(
          `${board.id}: Pyodide gowin_pack median ${sorted[2].toFixed(1)} ms ` +
            `(min ${sorted[0].toFixed(1)}, max ${sorted[4].toFixed(1)}); ` +
            `samples [${packTimes.map((elapsed) => elapsed.toFixed(1)).join(", ")}]; ` +
            `native ${nativeElapsed.toFixed(1)} ms; .fs ${nativeFs.length} bytes`,
        );
        if (board === BOARDS[0]) {
          assert.match(fallbackWarning, /fastcrc/i, "fastcrc fallback warning was not preserved");
        }
      } finally {
        rmSync(nativeWorkdir, { recursive: true, force: true });
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
}

function loadLibraryTree(directory) {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).map((entry) => {
    const pathname = path.join(directory, entry.name);
    return [entry.name, entry.isDirectory() ? loadLibraryTree(pathname) : new Uint8Array(readFileSync(pathname))];
  }));
}

const simulatedCpus = new Map();

function assertCpuLoweredExecution(id, workdir, netlistHash) {
  if (simulatedCpus.has(id)) {
    assert.equal(simulatedCpus.get(id).netlistHash, netlistHash, "The CPU netlist differs between boards");
    return simulatedCpus.get(id);
  }
  const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
  const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) =>
    [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
  for (const broken of [false, true]) {
    const directory = path.join(workdir, broken ? "lowered-led-stuck" : "lowered-positive");
    mkdirSync(directory);
    const files = [
      { path: "src/top.v", content: readFileSync(path.join(workdir, "src/lowered.v")) },
      { path: "src/tb.v", content: cpuBench({ ledHeld: broken }) },
    ];
    const native = nativeSimulation(directory, files, { includeDirectories: ["src"], defines: {} });
    const wasm = runIverilog({ modules, files, top: "tb" });
    writeFileSync(path.join(directory, "results.json"), JSON.stringify({
      native: { status: native.status, stdout: native.stdout, stderr: native.stderr },
      wasm: { status: wasm.status, stdout: wasm.stdout, stderr: wasm.stderr },
    }, null, 2));
    if (wasm.tree?.work?.["wave.vcd"]) writeFileSync(path.join(directory, "wasm.vcd"), wasm.tree.work["wave.vcd"]);
    assert.equal(native.status, broken ? 1 : 0, `${native.stdout}\n${native.stderr}`);
    assert.equal(wasm.status, native.status, `${wasm.stdout}\n${wasm.stderr}`);
    assert.equal(wasm.stdout, native.stdout);
    assert.match(wasm.stdout, broken ? /CPU_GPIO_OUTPUT/ : /CPU_FUNCTION_OK/);
    assert.ok(native.vcd, "The lowered-RTL simulation produced no VCD");
    assert.deepEqual(Buffer.from(wasm.tree.work["wave.vcd"]), native.vcd);
  }
  const result = { netlistHash, positive: "passed", led_stuck: "rejected" };
  simulatedCpus.set(id, result);
  return result;
}

async function libraryBuildMatrix(t, { cpu = false } = {}) {
  const evidenceVariable = cpu ? "CPU_MATRIX_EVIDENCE" : "HDL_MATRIX_EVIDENCE";
  const keepEvidence = process.env[evidenceVariable] !== undefined;
  const directory = keepEvidence ? path.resolve(root, process.env[evidenceVariable]) : mkdtempSync(path.join(root, "build/t5-library-flow-"));
  if (keepEvidence) mkdirSync(directory);
  const suppliedAssets = cpu && process.env.CPU_LIBRARY_ASSETS;
  const assets = suppliedAssets ? path.resolve(root, suppliedAssets) : path.join(directory, "assets");
  const preflight = cpu && process.env.CPU_MATRIX_PREFLIGHT === "1";
  const requested = cpu && process.env.CPU_MATRIX_IDS?.split(",");
  const samples = cpu ? CPU_CASES.filter(({ id }) => !requested || requested.includes(id)) : HDL_LIBRARY_CASES;
  assert.ok(samples.length && (!requested || new Set(requested).size === samples.length), "Unknown CPU case");
  const fixtureDirectory = path.join(root, cpu ? "tests/fixtures/cpus" : "tests/fixtures/libraries");
  let passedBoards = 0;
  let capacityExceeded = 0;
  let frontendUnsupported = 0;
  try {
    const ghdlRoot = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
    const ghdlModule = new WebAssembly.Module(readFileSync(path.join(ghdlRoot, "ghdl-wasm/ghdl-synth.wasm")));
    const librariesTree = loadLibraryTree(path.join(ghdlRoot, "ghdl-native/lib/ghdl"));
    if (!suppliedAssets) {
    const built = spawnSync("python3", ["scripts/build-library-assets.py", "--output", assets], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(built.status, 0, `${built.stderr}\n${built.error ?? ""}`);
    }
    const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
    const matrix = samples.flatMap((sample) => BOARDS.map((board) => ({ ...sample, board })));
    for (const { id, component, language, fixture, board, frontendFailure } of matrix) {
      const recipe = catalog.entries.find((entry) => entry.id === id).components.find((entry) => entry.id === component);
      const expectedState = recipe.boards[board.id];
      const matrixOnly = cpu && !preflight && ["capacity-exceeded", "frontend-unsupported"].includes(expectedState);
      const selection = { id, component };
      const loadAsset = (asset) => readFileSync(path.join(assets, asset.asset));
      if (matrixOnly) {
        await assert.rejects(prepareLibrarySelection(catalog, selection, loadAsset, { board: board.id }), /このボードでは選択できません/);
      }
      const added = await prepareLibrarySelection(
        catalog, selection, loadAsset, { board: board.id, requireConfirmed: !preflight && !matrixOnly },
      );
      await t.test(`${id}/${board.id}`, async () => {
        const workdir = path.join(directory, id, board.id);
        for (const part of ["src", "constraints", "tmp"]) mkdirSync(path.join(workdir, part), { recursive: true });
        const measurement = { id, component, board: board.id, status: "failed", timings: {}, hashes: {} };
        measurement.selection = { catalog_state: expectedState, require_confirmed: !preflight && !matrixOnly, normal_selection_rejected: matrixOnly };
        const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
        try {
        const template = createBlinkTemplate(board.id, cpu ? "verilog" : language);
        const sourcePath = !cpu && language === "vhdl" ? "src/top.vhd" : "src/top.v";
        template.files.set(sourcePath, readFileSync(path.join(fixtureDirectory, fixture)));
        if (cpu) {
          template.files.set("src/top_tb.v", cpuBench());
          template.project.simulation.top = "tb";
          template.project.simulation.files = null;
          for (const name of ["memory.v", "bus.vh", "program.hex", ...(language === "vhdl" ? ["neorv32.vhd"] : [])]) {
            template.files.set(`src/${name}`, readFileSync(path.join(fixtureDirectory, name)));
          }
          template.project.files = [...template.files.keys()].map((path) => ({ path }));
        }
        const installed = await changeProjectLibraries(template.project, template.files, { add: added });
        const zip = await exportProjectZip(installed.project, installed.files);
        writeFileSync(path.join(workdir, "project.zip"), zip);
        measurement.hashes.project_zip = hash(zip);
        const restored = await importProjectZip(zip);
        const input = await prepareProjectInputs(restored.project, restored.files);
        assert.ok(input.files.some((file) => file.path.startsWith(`libraries/${id}/sources/`)));
        for (const file of input.files) {
          const target = path.join(workdir, file.path);
          mkdirSync(path.dirname(target), { recursive: true });
          writeFileSync(target, file.content);
        }
        if (frontendFailure) {
          assert.ok(preflight || expectedState === "frontend-unsupported", "Unrecorded CPU frontend failure");
          const wasmDir = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
          const modules = Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) =>
            [name, new WebAssembly.Module(readFileSync(path.join(wasmDir, `${name}.wasm`)))]));
          const started = performance.now();
          measurement.frontend_failure = assertCpuFrontendFailure(workdir, [
            ...input.files.filter((file) => /\.(?:v|vh|hex)$/i.test(file.path)), { path: "src/tb.v", content: cpuBench() },
          ], input, modules, frontendFailure);
          measurement.timings.frontend_check_ms = performance.now() - started;
          measurement.status = "frontend-unsupported";
          frontendUnsupported += 1;
          return;
        }
        let sources = input.files.filter((file) => file.role !== "data" && /\.v$/i.test(file.path));
        if (language === "vhdl") {
          const ordered = orderVhdlFiles(input.files.filter((file) => file.role !== "data" && /\.(?:vhd|vhdl)$/i.test(file.path)));
          assert.equal(ordered.ok, true, JSON.stringify(ordered));
          const started = performance.now();
          const generated = runGhdlSynth({ module: ghdlModule, librariesTree, files: ordered.order, top: cpu ? "neorv32_bridge" : "top", standard: "2008" });
          measurement.timings.ghdl_wasm_ms = performance.now() - started;
          writeFileSync(path.join(workdir, "ghdl.log"), generated.log);
          assert.equal(generated.status, 0, generated.log);
          const generatedPath = cpu ? "src/neorv32-generated.v" : "src/top.v";
          writeFileSync(path.join(workdir, generatedPath), generated.verilog);
          sources = [{ path: generatedPath, content: generated.verilog }, ...sources];
          measurement.ghdl_memory_bytes = generated.memoryBytes;
        }
        const source = sources.find((file) => file.path === "src/top.v");
        const command = verilogReadCommand(sources.map((file) => file.path), input);
        if (cpu) {
          const loweringStarted = performance.now();
          runYosysWasi(workdir, source.content, cpuLoweringCommand(command));
          const loweredNets = JSON.parse(readFileSync(path.join(workdir, "top.json"), "utf8")).modules.top.netnames;
          for (const name of ["i_req", "i_ack"]) {
            assert.ok(Object.hasOwn(loweredNets, name) && loweredNets[name].bits.length === 1 &&
              Number.isSafeInteger(loweredNets[name].bits[0]), `The lowered CPU observation ${name} is missing or constant`);
          }
          measurement.timings.yosys_lowering_ms = performance.now() - loweringStarted;
          for (const file of ["top.json", "yosys.stdout", "yosys.stderr"]) copyFileSync(path.join(workdir, file), path.join(workdir, `lowered-${file}`));
        }
        const synthStarted = performance.now();
        const synthesized = runYosysWasi(workdir, source.content, `${command}; ${gowinSynthesisCommand(board.id, "top", "top.json")}`);
        measurement.timings.yosys_wasi_ms = performance.now() - synthStarted;
        measurement.yosys_memory_bytes = synthesized.memoryBytes;
        const netlist = JSON.parse(readFileSync(path.join(workdir, "top.json"), "utf8"));
        measurement.timings.yosys_native_ms = runNativeYosys(workdir, `${command}; ${gowinSynthesisCommand(board.id, "top", "native-top.json")}`);
        assertYosysParity(JSON.parse(readFileSync(path.join(workdir, "native-top.json"), "utf8")), netlist);
        measurement.hashes.yosys_wasi = hash(readFileSync(path.join(workdir, "top.json")));
        measurement.hashes.yosys_native = hash(readFileSync(path.join(workdir, "native-top.json")));
        assert.ok(Object.keys(netlist.modules.top.cells).length > 0, "The library design was optimized away");
        assert.ok(Object.values(netlist.modules.top.cells).some((cell) => cell.type.startsWith("DFF")), "The library design has no retained state");
        if (cpu) {
          measurement.mapped_cpu_structure = inspectCpuStructure(netlist);
          measurement.lowered_execution = assertCpuLoweredExecution(id, workdir, hash(readFileSync(path.join(workdir, "lowered-top.json"))));
        }
        writeFileSync(path.join(workdir, "constraints/board.cst"), generateCst(board.id));
        const pnr = runWasi(workdir, pnrArgs(board));
        measurement.timings.pnr_wasi_ms = pnr.elapsed;
        measurement.pnr_memory_bytes = pnr.memoryBytes;
        const nativeArgs = pnrArgs(board);
        nativeArgs[nativeArgs.indexOf("--write") + 1] = "native-pnr.json";
        const nativePnr = runNative(workdir, nativeArgs);
        writeFileSync(path.join(workdir, "native-pnr.stdout"), nativePnr.stdout);
        writeFileSync(path.join(workdir, "native-pnr.stderr"), nativePnr.stderr);
        measurement.timings.pnr_native_ms = nativePnr.elapsed;
        measurement.pnr_exit_status = { wasi: pnr.status, native: nativePnr.status };
        measurement.pnr_errors = {
          wasi: executionErrorDetails(pnr.error),
          native: executionErrorDetails(nativePnr.error),
          native_signal: nativePnr.signal,
        };
        measurement.resources = parseDeviceUtilization(pnr.stderr, { allowExceeded: cpu });
        assert.deepEqual(parseDeviceUtilization(nativePnr.stderr, { allowExceeded: cpu }), measurement.resources);
        if (cpu && isCapacityExceeded(pnr, nativePnr, measurement.resources)) {
          assert.ok(preflight || expectedState === "capacity-exceeded", "Unrecorded CPU capacity failure");
          measurement.status = "capacity-exceeded";
          capacityExceeded += 1;
          return;
        }
        assert.equal(pnr.status, 0, `${pnr.stderr}\n${pnr.error ?? ""}`);
        assert.equal(nativePnr.status, 0, `${nativePnr.stderr}\n${nativePnr.error ?? ""}`);
        assert.deepEqual(parseDeviceUtilization(nativePnr.stderr), measurement.resources);
        const routedJson = readFileSync(path.join(workdir, "pnr.json"));
        const nativeRouted = readFileSync(path.join(workdir, "native-pnr.json"));
        assert.equal(hash(JSON.stringify(JSON.parse(nativeRouted))), hash(JSON.stringify(JSON.parse(routedJson))), "Native/WASI PNR JSON differs (including key order)");
        measurement.hashes.pnr_wasi = hash(routedJson);
        measurement.hashes.pnr_native = hash(nativeRouted);
        const nativeWorkdir = path.join(workdir, "native");
        mkdirSync(nativeWorkdir);
        const native = runNativePack(board, routedJson, nativeWorkdir);
        measurement.timings.pack_native_ms = native.elapsed;
        const packStarted = performance.now();
        const packed = await runGowinPack({
          loadPyodide: pyodideLoader, indexURL, apyculaWheelURL,
          netlistJson: routedJson, device: board.packDevice,
        });
        measurement.timings.pack_pyodide_ms = performance.now() - packStarted;
        writeFileSync(path.join(workdir, "pyodide.fs"), packed.fs);
        assertBoardIdcode(native.output, board);
        assertBoardIdcode(packed.fs, board);
        assert.deepEqual(Buffer.from(packed.fs), native.output, createDiffSummary(native.output, packed.fs));
        measurement.hashes.fs = hash(packed.fs);
        measurement.fs_bytes = packed.fs.length;
        measurement.pack_memory_bytes = packed.memoryBytes;
        measurement.peak_rss_so_far_kib = process.resourceUsage().maxRSS;
        assert.ok(preflight || expectedState === "confirmed", "Unrecorded successful board build");
        measurement.status = "passed";
        passedBoards += 1;
        } catch (error) {
          measurement.error = error.stack ?? String(error);
          throw error;
        } finally {
          writeFileSync(path.join(workdir, "measurement.json"), JSON.stringify(measurement, null, 2), { flag: "wx" });
        }
      });
    }
  } finally {
    const expectedBoards = BOARDS.length * samples.length;
    writeFileSync(path.join(directory, "summary.json"), JSON.stringify({ passed: passedBoards, capacity_exceeded: capacityExceeded, frontend_unsupported: frontendUnsupported, expected: expectedBoards, pyodideSetupMs }, null, 2), { flag: "wx" });
    if (passedBoards + capacityExceeded + frontendUnsupported === expectedBoards && !keepEvidence) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained library-flow evidence: ${directory}`);
  }
}

test("pinned HDL libraries build from portable ZIP into all four board bitstreams", (t) => libraryBuildMatrix(t));
test("pinned CPU libraries retain execution and classify all four board builds", (t) => libraryBuildMatrix(t, { cpu: true }));

test("invalid routed JSON and a missing Apicula wheel fail closed", async () => {
  await assert.rejects(
    runGowinPack({
      loadPyodide: pyodideLoader,
      indexURL,
      apyculaWheelURL,
      netlistJson: '{"broken":',
      device: BOARDS[0].packDevice,
    }),
    /gowin_pack exited|failed/i,
  );
  await assert.rejects(
    runGowinPack({
      loadPyodide: pyodideLoader,
      indexURL,
      apyculaWheelURL: pathToFileURL(path.join(root, "build/pack/missing-apycula.whl")).href,
      netlistJson: "{}",
      device: BOARDS[0].packDevice,
    }),
    /ENOENT|no such file/i,
  );
});

test("a wrong pack device is rejected or produces a different IDCODE", async () => {
  const routedJson = routedByBoard.get(BOARDS[0].id);
  assert.ok(routedJson, "Tang Nano 1K routed JSON was not produced");
  try {
    const packed = await runGowinPack({
      loadPyodide: pyodideLoader,
      indexURL,
      apyculaWheelURL,
      netlistJson: routedJson,
      device: BOARDS[3].packDevice,
    });
    const idcode = fsIdcode(new TextDecoder().decode(packed.fs));
    assert.ok(
      idcode === null || !fsIdcodeMatchesBoard(idcode, BOARDS[0]),
      "Wrong pack device produced a bitstream with the 1K IDCODE",
    );
  } catch (error) {
    assert.match(`${error.message}\n${error.stderr ?? ""}`, /device|family|chip|pack/i);
  }
});

test("a corrupted cached Apicula wheel hash makes the asset build fail", () => {
  const negativeRoot = mkdtempSync(path.join(root, "build/pack-negative-"));
  const negativeCache = path.join(negativeRoot, "cache");
  const negativeOutput = path.join(negativeRoot, "output");
  const cacheSource = path.join(root, "build/cache/pack");
  try {
    const wheels = readdirSync(cacheSource).filter((file) => file.endsWith(".whl"));
    assert.ok(wheels.some((file) => file.startsWith("apycula-")), "Apycula wheel cache is missing");
    mkdirSync(negativeCache, { recursive: true });
    for (const wheel of wheels) {
      copyFileSync(path.join(cacheSource, wheel), path.join(negativeCache, wheel));
    }
    const apyculaWheelName = wheels.find((file) => file.startsWith("apycula-"));
    const corrupted = readFileSync(path.join(negativeCache, apyculaWheelName));
    corrupted[0] ^= 0xff;
    writeFileSync(path.join(negativeCache, apyculaWheelName), corrupted);
    const result = spawnSync(path.join(root, "scripts/build-pack-assets.sh"), [], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PACK_ASSET_CACHE_DIR: negativeCache,
        PACK_ASSET_DIR: negativeOutput,
      },
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.notEqual(result.status, 0, "Asset build accepted a corrupted Apicula wheel");
    assert.match(`${result.stdout}\n${result.stderr}`, /Apycula wheel cache failed hash verification/);
  } finally {
    rmSync(negativeRoot, { recursive: true, force: true });
  }
});

function totalAssetSize(directory) {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = path.join(directory, entry.name);
    return total + (entry.isDirectory() ? totalAssetSize(entryPath) : statSync(entryPath).size);
  }, 0);
}

after(() => {
  console.log(
    `Pyodide gowin_pack setup ${pyodideSetupMs.toFixed(1)} ms; ` +
      `asset total ${totalAssetSize(packRoot)} bytes`,
  );
});
