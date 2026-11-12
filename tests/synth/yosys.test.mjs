import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { WASI } from "node:wasi";
import { createBlinkTemplate, TEMPLATE_PINS } from "../../web/lib/templates.mjs";
import { verilogReadCommand } from "../../web/lib/libraries.mjs";
import { assertYosysCreator } from "./yosys-parity.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const wasmPath = path.join(root, "build/wasi/yosys/yosys.wasm");
const wasmSharePath = path.join(root, "build/wasi/yosys/share");
const nativePath = path.join(root, "build/native/yosys");
const nativeSharePath = path.resolve(root, "build/native/share");
const yosysGitlink = execFileSync("git", ["rev-parse", "HEAD:vendor/yosys"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const [yosysVersion, yosysCommit] = execFileSync(
  "python3", [".github/scripts/check-pins.py", "yosys-pin"], { cwd: root, encoding: "utf8" },
).trim().split("\t");
assert.equal(yosysCommit, yosysGitlink, "Yosys pin and gitlink must match");
const wasmSize = statSync(wasmPath).size;
const wasmModule = new WebAssembly.Module(readFileSync(wasmPath));
const synthCommand = "read_verilog src/top.v; synth_gowin -top top -json top.json";

assert.ok(statSync(nativePath).isFile(), `Native Yosys is missing: ${nativePath}`);
assert.ok(statSync(wasmSharePath).isDirectory(), `WASI share directory is missing: ${wasmSharePath}`);

function createWorkdir(source) {
  const workdir = mkdtempSync(path.join(tmpdir(), "yosys-synth-"));
  mkdirSync(path.join(workdir, "src"));
  mkdirSync(path.join(workdir, "tmp"));
  writeFileSync(path.join(workdir, "src/top.v"), source);
  return workdir;
}

function runNative(workdir, command = synthCommand) {
  const started = performance.now();
  const result = spawnSync(nativePath, ["-q", "-p", command], {
    cwd: workdir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stderr: result.stderr ?? "",
    elapsed: performance.now() - started,
    error: result.error,
  };
}

function runWasi(workdir, command = synthCommand) {
  const stdoutPath = path.join(workdir, "wasi.stdout");
  const stderrPath = path.join(workdir, "wasi.stderr");
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(stderrPath, "w");
  const wasi = new WASI({
    version: "preview1",
    args: ["yosys", "-q", "-p", command],
    env: {},
    preopens: {
      "/": workdir,
      "/share": wasmSharePath,
    },
    stdout,
    stderr,
    returnOnExit: true,
  });
  const started = performance.now();
  let status;
  let error;
  try {
    const instance = new WebAssembly.Instance(wasmModule, wasi.getImportObject());
    status = wasi.start(instance);
  } catch (caught) {
    error = caught;
    status = 1;
  } finally {
    for (const fd of [stdout, stderr]) {
      try {
        closeSync(fd);
      } catch (caught) {
        if (caught.code !== "EBADF") {
          throw caught;
        }
      }
    }
  }
  return {
    status: Number.isInteger(status) ? status : 0,
    stderr: readFileSync(stderrPath, "utf8"),
    elapsed: performance.now() - started,
    error,
  };
}

test("library include and literal define options reach the real native and WASI Yosys parsers", () => {
  const workdir = mkdtempSync(path.join(root, "build/t5-yosys-options-"));
  let passed = false;
  try {
    mkdirSync(path.join(workdir, "src/includes"), { recursive: true });
    writeFileSync(path.join(workdir, "src/includes/probe.vh"), "`define CONSTANT `FLAG\n");
    writeFileSync(path.join(workdir, "src/top.v"), '`include "probe.vh"\nmodule top(output [3:0] value, output [7:0] message); assign value=`CONSTANT; assign message=`MESSAGE; endmodule\n');
    const command = `${verilogReadCommand(["src/top.v"], {
      includeDirectories: ["src/includes"], defines: { FLAG: "4'hc", MESSAGE: '"A"' },
    })}; hierarchy -check -top top; proc; opt; write_json top.json`;
    for (const [backend, run] of [["native", runNative], ["wasi", runWasi]]) {
      const result = run(workdir, command);
      writeFileSync(path.join(workdir, `${backend}-options.stderr`), result.stderr);
      assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`);
      const netlist = JSON.parse(readFileSync(path.join(workdir, "top.json"), "utf8"));
      assert.deepEqual(netlist.modules.top.ports.value.bits, ["0", "0", "1", "1"]);
      assert.deepEqual(netlist.modules.top.ports.message.bits, ["1", "0", "0", "0", "0", "0", "1", "0"]);
      const broken = run(workdir, 'read_verilog "-Isrc/includes" "src/top.v"');
      writeFileSync(path.join(workdir, `${backend}-quoted-option.stderr`), broken.stderr);
      assert.notEqual(broken.status, 0);
      assert.match(broken.stderr, /File `-Isrc\/includes' not found/);
    }
    passed = true;
  } finally {
    if (passed) rmSync(workdir, { recursive: true, force: true });
    else console.error(`Retained Yosys option evidence: ${workdir}`);
  }
});

function normalizeSourcePaths(document) {
  let substitutions = 0;

  function replaceStrings(value) {
    if (typeof value === "string") {
      substitutions += value.split(nativeSharePath).length - 1;
      return value.replaceAll(nativeSharePath, "/share");
    }
    if (Array.isArray(value)) {
      return value.map(replaceStrings);
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        value[key] = replaceStrings(child);
      }
    }
    return value;
  }

  function visit(value) {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "attributes" && child !== null && typeof child === "object" && !Array.isArray(child)) {
        for (const [attribute, attributeValue] of Object.entries(child)) {
          if (attribute === "src") {
            child[attribute] = replaceStrings(attributeValue);
          } else {
            visit(attributeValue);
          }
        }
      } else {
        visit(child);
      }
    }
  }

  visit(document);
  return substitutions;
}

function assertKeyOrderEqual(expected, actual, jsonPath = "$") {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      assertKeyOrderEqual(expected[index], actual[index], `${jsonPath}[${index}]`);
    }
    return;
  }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  assert.deepStrictEqual(actualKeys, expectedKeys, `JSON key order differs at ${jsonPath}`);
  for (const key of expectedKeys) {
    assertKeyOrderEqual(expected[key], actual[key], `${jsonPath}.${key}`);
  }
}

function assertSynthesisJsonEqual(nativeDocument, wasiDocument) {
  const native = structuredClone(nativeDocument);
  const wasi = structuredClone(wasiDocument);
  for (const document of [native, wasi]) {
    assertYosysCreator(document.creator);
  }

  // Yosys embeds build identity in creator and the runtime-mounted share path in attributes.src.
  wasi.creator = native.creator;
  const substitutions = normalizeSourcePaths(native) + normalizeSourcePaths(wasi);
  assert.ok(substitutions > 0, "No native share paths were found under attributes.src");
  assertKeyOrderEqual(native, wasi);
  assert.deepStrictEqual(native, wasi);
  return substitutions;
}

function mutateFirstCellParameter(document) {
  for (const module of Object.values(document.modules ?? {})) {
    for (const cell of Object.values(module.cells ?? {})) {
      const parameter = Object.keys(cell.parameters ?? {})[0];
      if (parameter !== undefined) {
        const value = cell.parameters[parameter];
        cell.parameters[parameter] = typeof value === "string" ? `${value}_mutated` : `${value}x`;
        return;
      }
    }
  }
  assert.fail("No cell parameter was available for the negative control");
}

function assertSuccessful(result, runtime, boardId) {
  assert.equal(result.error, undefined, `${runtime} ${boardId}: ${result.error ?? ""}`);
  assert.equal(result.status, 0, `${runtime} ${boardId} exited ${result.status}\n${result.stderr}`);
}

console.log(`WASI Yosys size: ${wasmSize} bytes`);

for (const boardId of Object.keys(TEMPLATE_PINS)) {
  test(`Yosys WASI and native synthesis match for ${boardId}`, () => {
    const { files } = createBlinkTemplate(boardId, "verilog");
    const source = files.get("src/top.v");
    assert.equal(typeof source, "string", `${boardId} Verilog template is missing`);
    const nativeWorkdir = createWorkdir(source);
    const wasiWorkdir = createWorkdir(source);
    try {
      const native = runNative(nativeWorkdir);
      const wasi = runWasi(wasiWorkdir);
      assertSuccessful(native, "native", boardId);
      assertSuccessful(wasi, "WASI", boardId);
      const nativeJson = JSON.parse(readFileSync(path.join(nativeWorkdir, "top.json"), "utf8"));
      const wasiJson = JSON.parse(readFileSync(path.join(wasiWorkdir, "top.json"), "utf8"));
      const substitutions = assertSynthesisJsonEqual(nativeJson, wasiJson);
      if (boardId === Object.keys(TEMPLATE_PINS)[0]) {
        for (const expected of [yosysVersion.replace(/^v/, ""), yosysGitlink.slice(0, 9)]) {
          const wrongCreator = structuredClone(wasiJson);
          wrongCreator.creator = wrongCreator.creator.replace(expected, "unpinned");
          assert.throws(
            () => assertSynthesisJsonEqual(nativeJson, wrongCreator),
            /Unexpected Yosys creator/,
            "The comparison accepted an unpinned Yosys version or revision",
          );
        }
        const mutatedWasiJson = structuredClone(wasiJson);
        mutateFirstCellParameter(mutatedWasiJson);
        assert.throws(
          () => assertSynthesisJsonEqual(nativeJson, mutatedWasiJson),
          assert.AssertionError,
          "The comparison accepted a changed cell parameter",
        );
      }
      console.log(
        `${boardId}: native ${native.elapsed.toFixed(1)} ms; WASI ${wasi.elapsed.toFixed(1)} ms; ` +
          `share path substitutions ${substitutions}`,
      );
    } finally {
      rmSync(nativeWorkdir, { recursive: true, force: true });
      rmSync(wasiWorkdir, { recursive: true, force: true });
    }
  });
}

test("WASI and native Yosys report the syntax-error line", () => {
  const invalidSource = "module top;\n  assign out = ;\nendmodule\n";
  const nativeWorkdir = createWorkdir(invalidSource);
  const wasiWorkdir = createWorkdir(invalidSource);
  try {
    for (const [runtime, result] of [
      ["native", runNative(nativeWorkdir)],
      ["WASI", runWasi(wasiWorkdir)],
    ]) {
      assert.notEqual(result.status, 0, `${runtime} accepted invalid Verilog`);
      assert.match(result.stderr, /(?:line\s+2|top\.v:2\b)/i, `${runtime} stderr omitted line 2:\n${result.stderr}`);
    }
  } finally {
    rmSync(nativeWorkdir, { recursive: true, force: true });
    rmSync(wasiWorkdir, { recursive: true, force: true });
  }
});
