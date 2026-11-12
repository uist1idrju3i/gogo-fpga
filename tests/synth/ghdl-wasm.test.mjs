// Adapted from synth-explorer/tools/ghdl-wasm/ghdl_synth_test.mjs.
// Copyright 2025 synth-explorer contributors.
// Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { getVhdlLibrary } from "../../web/lib/vhdl-order.mjs";
import { prepareLibrarySelection } from "../../web/lib/libraries.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import { exportProjectZip, importProjectZip } from "../../web/lib/project-zip.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { HDL_LIBRARY_CASES } from "../fixtures/libraries/cases.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const buildRoot = path.resolve(root, process.env.GHDL_WASM_BUILD_ROOT ?? "build");
const fixtureRoot = path.join(root, "tests/fixtures/vhdl");
const wasmPath = path.join(buildRoot, "ghdl-wasm/ghdl-synth.wasm");
const libDir = path.join(buildRoot, "ghdl-native/lib/ghdl");
const nativePath = path.join(buildRoot, "ghdl-native/bin/ghdl");
const wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
const librariesTree = loadLibraryTree(libDir);

test("pinned VHDL libraries preserve their named library after portable ZIP import", async (t) => {
  const directory = mkdtempSync(path.join(root, "build/t5-vhdl-libraries-"));
  const assets = path.join(directory, "assets");
  let passed = 0;
  const cases = HDL_LIBRARY_CASES.filter(({ language }) => language === "vhdl");
  try {
    const built = spawnSync("python3", ["scripts/build-library-assets.py", "--output", assets], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(built.status, 0, `${built.stderr}\n${built.error ?? ""}`);
    const catalog = JSON.parse(readFileSync(path.join(assets, "catalog.json"), "utf8"));
    for (const { id, component, fixture } of cases) {
      await t.test(id, async () => {
        const added = await prepareLibrarySelection(
          catalog, { id, component },
          (asset) => readFileSync(path.join(assets, asset.asset)), { board: "tangnano20k" },
        );
        const template = createBlinkTemplate("tangnano20k", "vhdl");
        template.files.set("src/top.vhd", readFileSync(path.join(root, "tests/fixtures/libraries", fixture)));
        const installed = await changeProjectLibraries(template.project, template.files, { add: added });
        const zip = await exportProjectZip(installed.project, installed.files);
        writeFileSync(path.join(directory, `${id}.zip`), zip);
        const restored = await importProjectZip(zip);
        const input = await prepareProjectInputs(restored.project, restored.files);
        const sources = input.files.filter((file) => file.role !== "data" && /\.(vhd|vhdl)$/i.test(file.path));
        assert.ok(sources.some((file) => file.path.startsWith(`libraries/${id}/`) && file.library !== "work"));
        const native = runNative("top", sources);
        assert.equal(native.status, 0, `${native.output}\n${native.stderr ?? ""}\n${native.error ?? ""}`);
        const wasm = await runWasm("top", sources);
        assert.equal(wasm.status, 0, wasm.log);
        assert.equal(wasm.verilog, native.output, differenceSummary(native.output, wasm.verilog));
        assert.match(wasm.verilog, /module top/);
        passed += 1;
      });
    }
  } finally {
    if (passed === cases.length) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained failing VHDL library evidence: ${directory}`);
  }
});

assert.ok(statSync(libDir).isDirectory(), `GHDL libraries are missing: ${libDir}`);
assert.ok(statSync(nativePath).isFile(), `Native GHDL is missing: ${nativePath}`);

function loadLibraryTree(directory) {
  const tree = {};
  for (const name of readdirSync(directory)) {
    const pathname = path.join(directory, name);
    tree[name] = statSync(pathname).isDirectory()
      ? loadLibraryTree(pathname)
      : new Uint8Array(readFileSync(pathname));
  }
  return tree;
}

function fixtureFiles(names) {
  return names.map((name) => {
    const file = typeof name === "string" ? { path: name } : name;
    return { ...file, content: file.content ?? new Uint8Array(readFileSync(path.join(fixtureRoot, file.path))) };
  });
}

function runWasm(top, names, standard = "2008") {
  return runGhdlSynth({
    module: wasmModule,
    librariesTree,
    files: fixtureFiles(names),
    top,
    standard,
  });
}

function runNative(top, names, standard = "2008") {
  const workDir = mkdtempSync(path.join(tmpdir(), "ghdl-native-"));
  const nativeStandard = standard === "2019" ? "19" : "08";
  try {
    for (const file of fixtureFiles(names)) {
      mkdirSync(path.dirname(path.join(workDir, file.path)), { recursive: true });
      writeFileSync(path.join(workDir, file.path), file.content);
    }
    for (const file of fixtureFiles(names).filter((file) => file.role !== "data")) {
      const analyze = spawnSync(
        nativePath,
        ["-a", `--std=${nativeStandard}`, `--work=${getVhdlLibrary(file)}`, file.path],
        { cwd: workDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
      );
      if (analyze.status !== 0) {
        return {
          status: analyze.status ?? 1,
          output: `${analyze.stdout ?? ""}${analyze.stderr ?? ""}`,
          error: analyze.error,
        };
      }
    }
    const synthesis = spawnSync(
      nativePath,
      ["--synth", `--std=${nativeStandard}`, "--out=verilog", top],
      { cwd: workDir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    return {
      status: synthesis.status ?? 1,
      output: synthesis.stdout ?? "",
      stderr: synthesis.stderr ?? "",
      error: synthesis.error,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function differenceSummary(expected, actual) {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  let offset = 0;
  while (
    offset < expectedBytes.length &&
    offset < actualBytes.length &&
    expectedBytes[offset] === actualBytes[offset]
  ) {
    offset += 1;
  }
  const expectedText = expectedBytes.toString("latin1");
  const actualText = actualBytes.toString("latin1");
  const snippet = (text) => JSON.stringify(text.slice(Math.max(0, offset - 24), offset + 48));
  return (
    `first byte difference at offset ${offset}; native=${expectedBytes.length} bytes ` +
    `${snippet(expectedText)}; WASM=${actualBytes.length} bytes ${snippet(actualText)}`
  );
}

const positiveFixtures = [
  { label: "combinational logic", top: "combinational", files: ["combinational.vhd"] },
  { label: "numeric_std counter", top: "counter", files: ["counter.vhd"] },
  { label: "generic entity", top: "generic_mux", files: ["generic_mux.vhd"] },
  { label: "FSM", top: "fsm", files: ["fsm.vhd"] },
  {
    label: "package dependency and entity instantiation",
    top: "package_top",
    files: ["bit_ops.vhd", "package_top.vhd"],
  },
  {
    label: "Tang Nano 20K LED blink",
    top: "top",
    files: ["tangnano20k_led_blink.vhd"],
  },
  {
    label: "VHDL-2019 named return identifier",
    top: "top",
    files: ["return_identifier_top.vhd"],
    standard: "2019",
  },
];

const namedFixtures = [
  { path: "named-alpha-pkg.vhd", library: "alpha" },
  { path: "named-beta-pkg.vhd", library: "beta" },
  { path: "named-alpha-body.vhd", library: "alpha" },
  { path: "named-beta-body.vhd", library: "beta" },
  { path: "named-alpha-child.vhd", library: "alpha" },
  { path: "named-beta-child.vhd", library: "beta" },
  { path: "named-top.vhd", library: "work" },
  { path: "named-unused.vhd", library: "alpha" },
];

for (const standard of ["2008", "2019"]) {
  test(`named VHDL libraries preserve separate same-named units and work aliases (${standard})`, () => {
    const native = runNative("named_top", namedFixtures, standard);
    assert.equal(native.status, 0, native.output);
    const wasm = runWasm("named_top", namedFixtures, standard);
    assert.equal(wasm.status, 0, wasm.log);
    assert.equal(wasm.verilog, native.output, differenceSummary(native.output, wasm.verilog));
  });
}

test("wrong named-library assignments fail instead of flattening units into work", () => {
  const broken = namedFixtures.map((file) => file.path === "named-beta-pkg.vhd" ? { ...file, library: "alpha" } : file);
  assert.notEqual(runNative("named_top", broken).status, 0);
  const wasm = runWasm("named_top", broken);
  assert.notEqual(wasm.status, 0);
  assert.equal(wasm.stage, "analyze");
});

test("a GHDL module without the library export remains usable for work but rejects named libraries", () => {
  const bytes = Buffer.from(readFileSync(wasmPath));
  const exportedName = "synth_api__synth_set_library";
  const position = bytes.indexOf(exportedName);
  assert.ok(position > 0);
  bytes.write("synth_api__synth_set_librarX", position, "ascii");
  const module = new WebAssembly.Module(bytes);
  assert.equal(WebAssembly.Module.exports(module).some(({ name }) => name === exportedName), false);
  const ordinary = runGhdlSynth({ module, librariesTree, files: fixtureFiles(["combinational.vhd"]), top: "combinational" });
  assert.equal(ordinary.status, 0, ordinary.log);
  const named = runGhdlSynth({ module, librariesTree, files: fixtureFiles(namedFixtures), top: "named_top" });
  assert.notEqual(named.status, 0);
  assert.equal(named.stage, "library");
  assert.match(named.log, /does not support named VHDL libraries/);
});

test("GHDL synthesis reads project ROM data without analyzing data assets as VHDL", () => {
  const names = ["rom-data.vhd", { path: "rom-data.hex", role: "data" }];
  const native = runNative("rom_data", names);
  assert.equal(native.status, 0, native.output);
  const wasm = runWasm("rom_data", names);
  assert.equal(wasm.status, 0, wasm.log);
  assert.match(wasm.log, /note: found ROM/);
  assert.equal(wasm.verilog, native.output, differenceSummary(native.output, wasm.verilog));
  assert.notEqual(runWasm("rom_data", ["rom-data.vhd"]).status, 0);
});

test("GHDL compiles prototype member paths without mutating JavaScript prototypes", () => {
  const [fixture] = fixtureFiles(["combinational.vhd"]);
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  const filename = "ghdl-probe.vhd";
  assert.equal(Object.hasOwn(Object.prototype, filename), false);
  try {
    for (const name of ["__proto__", "constructor", "prototype", "toString"]) {
      const result = runGhdlSynth({
        module: wasmModule,
        librariesTree,
        files: [{ ...fixture, path: `${name}/${filename}` }],
        top: "combinational",
      });
      assert.equal(result.status, 0, result.log);
      assert.match(result.verilog, /module combinational/);
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
    }
  } finally {
    delete Object.prototype[filename];
  }
});

for (const fixture of positiveFixtures) {
  test(`GHDL WASM synthesizes ${fixture.label}`, () => {
    const standard = fixture.standard ?? "2008";
    const wasm = runWasm(fixture.top, fixture.files, standard);
    if (process.env.GHDL_WASM_TIMING_RUN) {
      console.log(
        `S9B_TIMING ${JSON.stringify({
          run: process.env.GHDL_WASM_TIMING_RUN,
          fixture: fixture.label,
          duration_ms: wasm.durationMs,
        })}`,
      );
    }
    assert.equal(
      wasm.status,
      0,
      `WASM synthesis failed at ${wasm.stage}:\n${wasm.log}`,
    );
    assert.match(wasm.verilog, new RegExp(`module\\s+${fixture.top}\\b`));

    const native = runNative(fixture.top, fixture.files, standard);
    assert.equal(native.status, 0, `Native synthesis failed:\n${native.output}\n${native.error ?? ""}`);
    assert.equal(
      wasm.verilog,
      native.output,
      `${fixture.label}: ${differenceSummary(native.output, wasm.verilog)}`,
    );
    if (process.env.GHDL_WASM_EXPORT_DIR) {
      mkdirSync(process.env.GHDL_WASM_EXPORT_DIR, { recursive: true });
      writeFileSync(
        path.join(process.env.GHDL_WASM_EXPORT_DIR, `${fixture.top}.v`),
        wasm.verilog,
        "latin1",
      );
    }
    console.log(`${fixture.label}: byte-identical`);
  });
}

for (const name of ["syntax_error.vhd", "semantic_error.vhd"]) {
  test(`GHDL WASM reports file and line for ${name}`, () => {
    const result = runWasm(name.replace(/\.vhd$/, ""), [name]);
    assert.notEqual(result.status, 0, "Invalid VHDL unexpectedly synthesized");
    assert.match(
      result.log,
      new RegExp(`${name.replaceAll(".", "\\.")}:\\d+(?::\\d+)?`),
      `No file:line diagnostic at ${result.stage}`,
    );
  });
}
