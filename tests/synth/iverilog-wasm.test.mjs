import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import {
  createMemoryTree,
  runWasiP1,
} from "../../web/lib/wasi-p1.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";
import { inspectInstalledLibraries, prepareLibrarySelection } from "../../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../../web/lib/project-zip.mjs";
import { nativeSimulation } from "./iverilog-helpers.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDir = path.join(repo, "tests/fixtures/iverilog");
const wasmDir = path.resolve(process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const nativeDir = path.resolve(process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
const fixtures = [
  "counter",
  "combinational",
  "fsm",
  "include_define",
  "readmemh",
  "generate",
  "finish",
];

function loadModules(directory, suffix) {
  const load = (name) => new WebAssembly.Module(readFileSync(path.join(directory, `${name}${suffix}`)));
  return { ivlpp: load("ivlpp"), ivl: load("ivl"), vvp: load("vvp") };
}

const modules = loadModules(wasmDir, ".wasm");
const nativeTools = Object.fromEntries(
  ["ivlpp", "ivl", "vvp"].map((name) => [name, path.join(nativeDir, name)]),
);
for (const toolPath of Object.values(nativeTools)) {
  if (!existsSync(toolPath)) throw new Error(`Native Icarus tool is missing: ${toolPath}`);
}

test("simulation worker forwards include/define options and treats a .v ROM asset as data rather than HDL", async () => {
  const originalSelf = globalThis.self;
  const originalFetch = globalThis.fetch;
  let listener;
  const messages = [];
  globalThis.self = {
    addEventListener: (type, callback) => { if (type === "message") listener = callback; },
    postMessage: (message) => messages.push(message),
  };
  globalThis.fetch = async (url) => {
    const name = path.basename(url.pathname);
    assert.ok(["ivlpp.wasm", "ivl.wasm", "vvp.wasm"].includes(name));
    return new Response(readFileSync(path.join(wasmDir, name)));
  };
  try {
    await import("../../web/sim-worker.js?library-options-test");
    const romPaths = ["libraries/fixture/sources/data/rom.v", "work/rom.v", "tmp/rom.v", "share/rom.v"];
    const input = {
      top: "tb",
      includeDirectories: ["libraries/fixture/sources/include"],
      defines: { FLAG: 11 },
      files: [
        { path: "libraries/fixture/sources/include/nested/component.vh", role: "source", content: "`define EXPECTED 42\n" },
        ...romPaths.map((path) => ({ path, role: "data", content: "2a\n" })),
        { path: "src/tb.v", content: [
          '`include "nested/component.vh"',
          "module tb;",
          "reg [7:0] memory [0:0];",
          "initial begin",
          ...romPaths.flatMap((path) => [
            `  $readmemh("${path}", memory);`,
            '  if (memory[0] !== `EXPECTED || `FLAG !== 11) $fatal(1, "Mismatch");',
          ]),
          '  $display("LIBRARY_ROM_OK");',
          '  $dumpfile("wave.vcd");',
          "  $dumpvars(0, tb);",
          "  #1 $finish;",
          "end",
          "endmodule",
        ].join("\n") },
      ],
    };
    await listener({ data: input });
    const result = messages.find(({ type }) => type === "done")?.result;
    assert.ok(result, JSON.stringify(messages));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /LIBRARY_ROM_OK/);
    for (const invalid of [{ ...input, includeDirectories: [] }, { ...input, defines: {} }]) {
      messages.length = 0;
      await listener({ data: invalid });
      assert.notEqual(messages.find(({ type }) => type === "done")?.result.status, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});

function filesFor(name, boardId) {
  if (boardId) {
    const template = createBlinkTemplate(boardId, "verilog");
    return [
      { path: "src/top.v", content: template.files.get("src/top.v") },
      {
        path: "src/testbench.v",
        content: [
          "`timescale 1ns/1ps",
          "module tb;",
          "  reg clk = 0;",
          "  wire led;",
          "  top dut(.clk(clk), .led(led));",
          "  always #5 clk = ~clk;",
          "  initial begin",
          '    $dumpfile("wave.vcd");',
          "    $dumpvars(0, tb);",
          "    repeat (4) begin",
          "      @(posedge clk);",
          '      $display("led=%0b", led);',
          "    end",
          "    $finish;",
          "  end",
          "endmodule",
          "",
        ].join("\n"),
      },
    ];
  }
  const files = [{
    path: `src/${name}.v`,
    content: readFileSync(path.join(fixtureDir, `${name}.v`), "utf8"),
  }];
  for (const dependency of ["constants.vh", "data.hex"]) {
    const candidate = path.join(fixtureDir, dependency);
    if (existsSync(candidate)) {
      files.push({ path: `src/${dependency}`, content: readFileSync(candidate) });
    }
  }
  return files;
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SOURCE_DATE_EPOCH: "0", TZ: "UTC" },
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runNative(name, boardId, files = filesFor(name, boardId)) {
  const root = mkdtempSync(path.join(os.tmpdir(), "iverilog-native-"));
  try {
    const top = boardId ? "tb" : "top";
    const sourceFiles = files
      .filter((file) => file.path.endsWith(".v"))
      .map((file) => `work/${file.path}`);
    for (const file of files) {
      const target = path.join(root, "work", file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    writeFileSync(path.join(root, "work/ivlpp.flags"), "I:work/src\n");
    writeFileSync(
      path.join(root, "work/ivl.conf"),
      [
        "module:system",
        "flag:DLL=vvp.tgt",
        "flag:VVP_EXECUTABLE=vvp",
        "functor:cprop",
        "functor:nodangle",
        `root:${top}`,
        "out:work/design.vvp",
        "generation:2",
      ].join("\n"),
    );
    const preprocessed = capture(
      nativeTools.ivlpp,
      ["-F", "work/ivlpp.flags", "-L", ...sourceFiles],
      root,
    );
    if (preprocessed.status !== 0) return { ...preprocessed, vcd: null };
    writeFileSync(path.join(root, "work/preprocessed.v"), preprocessed.stdout);
    const compiled = capture(nativeTools.ivl, ["-C", "work/ivl.conf", "work/preprocessed.v"], root);
    if (compiled.status !== 0) return { ...compiled, vcd: null };
    const simulated = capture(nativeTools.vvp, ["design.vvp"], path.join(root, "work"));
    const vcdPath = path.join(root, "work/wave.vcd");
    return {
      ...simulated,
      vcd: existsSync(vcdPath) ? readFileSync(vcdPath) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runWasm(name, boardId, onPollOneoff) {
  const files = filesFor(name, boardId);
  return runIverilog({
    modules,
    files,
    sourceFiles: files.filter((file) => file.path.endsWith(".v")).map((file) => file.path),
    top: boardId ? "tb" : "top",
    includeDirs: ["src"],
    onPollOneoff,
  });
}

function normalizedDiagnostic(text) {
  return text
    .replace(/(?:\/)?work\/src\//g, "src/")
    .split(/\r?\n/)
    .filter((line) => /error|fatal/i.test(line))
    .join("\n");
}

test("pinned libfpga survives portable ZIP and runs exhaustive Gray conversion in native and WASM", async () => {
  const directory = mkdtempSync(path.join(repo, "build/t5-library-simulation-"));
  const assets = path.join(directory, "assets");
  try {
    const built = capture("python3", ["scripts/build-library-assets.py", "--output", assets], repo);
    assert.equal(built.status, 0, built.stderr);
    const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
    const added = await prepareLibrarySelection(catalog, { id: "libfpga", component: "gray" },
      (asset) => readFileSync(path.join(assets, asset.asset)), { requireConfirmed: false });
    const template = createBlinkTemplate("tangnano1k", "verilog");
    template.files.set("src/top.v", readFileSync(path.join(fixtureDir, "library_gray.v"), "utf8"));
    template.project.simulation.top = "top";
    const installed = await changeProjectLibraries(template.project, template.files, { add: added });
    const restored = await importProjectZip(await exportProjectZip(installed.project, installed.files));
    const state = await inspectInstalledLibraries(restored.project, restored.files, catalog);
    assert.equal(state.records.length, 1);
    assert.equal(state.records[0].matched, true);
    const licensePath = "libraries/libfpga/sources/LICENSE";
    assert.deepEqual(Buffer.from(restored.files.get(licensePath)), readFileSync(path.join(repo, "third_party/libfpga/LICENSE")));
    assert.ok([...restored.files.keys()].filter((file) => file.startsWith("libraries/"))
      .every((file) => file.startsWith("libraries/libfpga/")));
    const input = await prepareProjectInputs(restored.project, restored.files, { simulation: true });
    for (const broken of [false, true]) {
      const files = input.files.map((file) => file.path === "src/top.v" && broken
        ? { ...file, content: Buffer.from(file.content).toString("utf8").replace("decoded !== value", "decoded !== (value ^ 8'h01)") }
        : file);
      const native = runNative(null, undefined, files);
      const wasm = runIverilog({ modules, files, top: input.project.simulation.top,
        includeDirs: input.includeDirectories, defines: input.defines });
      assert.equal(native.status, broken ? 1 : 0, `${native.stdout}\n${native.stderr}`);
      assert.equal(wasm.status, native.status, `${wasm.stdout}\n${wasm.stderr}`);
      assert.equal(wasm.stdout, native.stdout);
      assert.deepEqual(Buffer.from(wasm.tree.work["wave.vcd"]), native.vcd);
      assert.match(wasm.stdout, broken ? /Inverse mismatch/ : /GRAY_256_OK/);
    }
    const corrupt = new Map(restored.files);
    corrupt.set("libraries/libfpga/sources/rtl/math/lfpga_gray.v", "module invalid; endmodule\n");
    await assert.rejects(exportProjectZip(restored.project, corrupt), /ハッシュ/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Icarus WASI pipeline matches native stdout and VCD", () => {
  for (const name of fixtures) {
    const native = runNative(name);
    let pollOneoffCalls = 0;
    const wasm = runWasm(name, undefined, () => {
      pollOneoffCalls += 1;
    });
    assert.equal(native.status, 0, `${name}: native failed: ${native.stderr}`);
    assert.equal(wasm.status, 0, `${name}: WASI failed: ${wasm.stderr}`);
    assert.equal(wasm.stdout, native.stdout, `${name}: stdout differs`);
    assert.equal(pollOneoffCalls, 0, `${name}: poll_oneoff is required`);
    assert.ok(native.vcd, `${name}: native VCD missing`);
    assert.ok(wasm.tree.work["wave.vcd"], `${name}: WASI VCD missing`);
    assert.deepEqual(Buffer.from(wasm.tree.work["wave.vcd"]), native.vcd, `${name}: VCD differs`);
  }
});

test("four board Verilog templates match native stdout and VCD", () => {
  for (const boardId of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
    const native = runNative(null, boardId);
    let pollOneoffCalls = 0;
    const wasm = runWasm(null, boardId, () => {
      pollOneoffCalls += 1;
    });
    assert.equal(native.status, 0, `${boardId}: native failed: ${native.stderr}`);
    assert.equal(wasm.status, 0, `${boardId}: WASI failed: ${wasm.stderr}`);
    assert.doesNotMatch(
      `${native.stderr}\n${wasm.stderr}`,
      /timescale|time unit/i,
      `${boardId}: timescale warning`,
    );
    assert.equal(wasm.stdout, native.stdout, `${boardId}: stdout differs`);
    assert.equal(pollOneoffCalls, 0, `${boardId}: poll_oneoff is required`);
    assert.ok(native.vcd, `${boardId}: native VCD missing`);
    assert.ok(wasm.tree.work["wave.vcd"], `${boardId}: WASI VCD missing`);
    assert.deepEqual(
      Buffer.from(wasm.tree.work["wave.vcd"]),
      native.vcd,
      `${boardId}: VCD differs`,
    );
  }
});

test("Icarus WASI negative controls match native status and diagnostics", () => {
  for (const name of ["syntax-error", "undefined-module", "fatal"]) {
    const native = runNative(name);
    const wasm = runWasm(name);
    assert.notEqual(native.status, 0, `${name}: native unexpectedly succeeded`);
    assert.equal(wasm.status, native.status, `${name}: exit status differs`);
    assert.equal(
      normalizedDiagnostic(wasm.stderr),
      normalizedDiagnostic(native.stderr),
      `${name}: diagnostic differs`,
    );
    if (name === "syntax-error") {
      assert.match(
        wasm.stages.ivl.stderr instanceof Uint8Array
          ? new TextDecoder().decode(wasm.stages.ivl.stderr)
          : wasm.stages.ivl.stderr,
        /work\/src\/syntax-error\.v:4: syntax error/,
      );
    }
  }
});

test("WASI ivlpp rejects VHDL input with a diagnostic", () => {
  const root = createMemoryTree({
    tmp: {},
    work: {
      "input.vhd": "entity input is end entity;\n",
      "ivlpp.flags": "",
    },
  });
  const stderr = [];
  const result = runWasiP1(modules.ivlpp, {
    args: ["ivlpp", "-F", "/work/ivlpp.flags", "-L", "/work/input.vhd"],
    preopens: { "/": root, "/tmp": root.entries.get("tmp") },
    stderr: (bytes) => stderr.push(bytes),
  });
  const message = Buffer.concat(stderr.map((chunk) => Buffer.from(chunk))).toString("utf8");
  assert.notEqual(result.exitCode, 0);
  assert.match(message, /VHDL input is not supported in this build/);
});

test("Icarus compiles prototype member paths without mutating JavaScript prototypes", () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const filename = "iverilog-probe.v";
  assert.equal(Object.hasOwn(Object.prototype, filename), false);
  try {
    for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
      const pathname = `${name}/${filename}`;
      const content = 'module top; initial begin $display("path-ok"); $finish; end endmodule';
      const result = runIverilog({
        modules,
        files: [{ path: pathname, content }],
        sourceFiles: [pathname],
        top: "top",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /path-ok/);
      assert.equal(Object.hasOwn(result.tree.work, name), true);
      assert.deepEqual(result.tree.work[name][filename], new TextEncoder().encode(content));
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    }
  } finally {
    delete Object.prototype[filename];
  }
});

test("corrupted Icarus WASM is rejected by the WebAssembly validator", () => {
  const bytes = readFileSync(path.join(wasmDir, "vvp.wasm"));
  bytes[0] ^= 0xff;
  assert.throws(() => new WebAssembly.Module(bytes), WebAssembly.CompileError);
});

test("native reference preserves compiler warnings just like WASM", () => {
  const directory = mkdtempSync(path.join(repo, "build/iverilog-warning-"));
  const files = [{ path: "top.v", content: "module top; always @* assert(1'b1); initial #1 $finish; endmodule" }];
  const native = nativeSimulation(directory, files, { includeDirectories: [], defines: {}, top: "top", formal: true });
  const wasm = runIverilog({ modules, files, top: "top", formal: true });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(wasm.status, 0, wasm.stderr);
  assert.match(native.stderr, /@\* found no sensitivities/);
  assert.equal(native.stderr, wasm.stderr);
  assert.match(readFileSync(path.join(directory, "ivl.stderr"), "utf8"), /@\* found no sensitivities/);
  assert.equal(JSON.parse(readFileSync(path.join(directory, "ivl.json"), "utf8")).status, 0);
});
