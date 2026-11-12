#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { BOARDS } from "../web/lib/boards.mjs";
import { createBlinkTemplate } from "../web/lib/templates.mjs";
import { runGhdlSynth } from "../web/lib/ghdl-host.mjs";
import { readUstar } from "../web/lib/ustar.mjs";

const root = path.resolve(import.meta.dirname, "..");
const options = parseArgs({
  options: {
    out: { type: "string", default: "docs/experiments/S0B/results.csv" },
    repeats: { type: "string", default: "5" },
    "base-build-root": { type: "string", default: "build/T3-2" },
    "b0-build-root": { type: "string", default: "build/S0B/B0" },
    "server-log": { type: "string", default: "build/S0B/measurement-server.log" },
    "verify-negative-controls": { type: "boolean", default: false },
    "tamper-wasm": { type: "boolean", default: false },
    "tamper-expected": { type: "boolean", default: false },
  },
}).values;

const repeats = Number(options.repeats);
const outputPath = path.resolve(root, options.out);
const baseBuildRoot = path.resolve(root, options["base-build-root"]);
const b0BuildRoot = path.resolve(root, options["b0-build-root"]);
const ghdlCases = [
  { id: "combinational", label: "combinational logic", top: "combinational", files: ["combinational.vhd"] },
  { id: "counter", label: "numeric_std counter", top: "counter", files: ["counter.vhd"] },
  { id: "generic", label: "generic entity", top: "generic_mux", files: ["generic_mux.vhd"] },
  { id: "fsm", label: "FSM", top: "fsm", files: ["fsm.vhd"] },
  {
    id: "package-instantiation",
    label: "package dependency and entity instantiation",
    top: "package_top",
    files: ["bit_ops.vhd", "package_top.vhd"],
  },
  {
    id: "tangnano20k-led-blink",
    label: "Tang Nano 20K LED blink",
    top: "top",
    files: ["tangnano20k_led_blink.vhd"],
  },
  {
    id: "vhdl-2019-return-identifier",
    label: "VHDL-2019 named return identifier",
    top: "top",
    files: ["return_identifier_top.vhd"],
    standard: "2019",
  },
];

const fixtureRoot = path.join(root, "tests/fixtures/vhdl");
const nativeGhdl = path.join(baseBuildRoot, "ghdl-native/bin/ghdl");
const librariesTarPath = path.join(baseBuildRoot, "synth/libraries.tar");
const nativeExpectedFsRoot = path.join(root, "build/e2e-expected");
const variants = [
  {
    name: "Os",
    wasmPath: path.join(baseBuildRoot, "ghdl-wasm/ghdl-synth.wasm"),
  },
  {
    name: "B0",
    wasmPath: path.join(b0BuildRoot, "ghdl-wasm/ghdl-synth.wasm"),
  },
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function csv(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function csvText(rows) {
  const columns = [
    "environment",
    "variant",
    "example_id",
    "example",
    "kind",
    "repeat",
    "order",
    "compile_ms",
    "run_ms",
    "downstream_environment",
    "verilog_sha256",
    "verilog_match",
    "memory_bytes",
    "fs_sha256",
    "fs_match",
    "synth_ms",
    "pnr_ms",
    "pack_ms",
    "status",
    "error",
  ];
  return `${columns.join(",")}\n${rows.map((row) =>
    columns.map((column) => csv(row[column])).join(",")
  ).join("\n")}\n`;
}

function csvNumber(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "";
}

function fixtureFiles(names) {
  return names.map((name) => ({
    path: name,
    content: new Uint8Array(readFileSync(path.join(fixtureRoot, name))),
  }));
}

function boardCases() {
  return BOARDS.map((board) => {
    const template = createBlinkTemplate(board.id, "vhdl");
    const sourcePath = [...template.files.keys()].find((name) => /\.vhd$/i.test(name));
    return {
      id: `${board.id}-vhdl-template`,
      label: `${board.label} VHDL template`,
      kind: "board",
      top: template.project.top,
      standard: template.project.vhdlStandard,
      board: board.id,
      files: [{ path: sourcePath, content: new TextEncoder().encode(template.files.get(sourcePath)) }],
      constraintPath: `constraints/${board.id}.cst`,
      constraint: template.files.get(`constraints/${board.id}.cst`),
      nativeFsPath: path.join(nativeExpectedFsRoot, `${board.id}-vhdl.fs`),
    };
  });
}

function allCases() {
  return [
    ...ghdlCases.map((fixture) => ({
      ...fixture,
      kind: "fixture",
      standard: fixture.standard ?? "2008",
      files: fixtureFiles(fixture.files),
    })),
    ...boardCases(),
  ];
}

function nativeSynthesis(testCase) {
  mkdirSync(path.join(root, "build/S0B"), { recursive: true });
  const workdir = mkdtempSync(path.join(root, "build/S0B/native-"));
  try {
    for (const file of testCase.files) {
      const pathname = path.join(workdir, file.path);
      mkdirSync(path.dirname(pathname), { recursive: true });
      writeFileSync(pathname, file.content);
    }
    const standard = testCase.standard === "2019" ? "19" : "08";
    const names = testCase.files.map(({ path: filePath }) => filePath);
    const analysis = spawnSync(
      nativeGhdl,
      ["-a", `--std=${standard}`, ...names],
      { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      analysis.status,
      0,
      `Native GHDL analysis failed for ${testCase.id}:\n${analysis.stdout ?? ""}${analysis.stderr ?? ""}`,
    );
    const synthesis = spawnSync(
      nativeGhdl,
      ["--synth", `--std=${standard}`, "--out=verilog", testCase.top],
      { cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      synthesis.status,
      0,
      `Native GHDL synthesis failed for ${testCase.id}:\n${synthesis.stdout ?? ""}${synthesis.stderr ?? ""}`,
    );
    return Buffer.from(synthesis.stdout ?? "", "latin1");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function loadNativeExpectations(cases) {
  const expected = new Map();
  for (const testCase of cases) {
    const verilog = nativeSynthesis(testCase);
    const entry = { verilog, verilogSha256: sha256(verilog) };
    if (testCase.kind === "board") {
      assert.ok(
        existsSync(testCase.nativeFsPath),
        `Native .fs expectation is missing: ${testCase.nativeFsPath}`,
      );
      const fsBytes = readFileSync(testCase.nativeFsPath);
      entry.fsSha256 = sha256(fsBytes);
      entry.fsBytes = fsBytes.byteLength;
    }
    expected.set(testCase.id, entry);
  }
  return expected;
}

function tamperWasmCode(source) {
  const bytes = Buffer.from(source);
  const readUleb = (offset) => {
    let value = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < bytes.length) {
      const byte = bytes[cursor++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return { value: value >>> 0, next: cursor };
    }
    throw new Error("Unexpected end of WASM section.");
  };
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset];
    const size = readUleb(offset + 1);
    if (sectionId === 10) {
      const functionCount = readUleb(size.next);
      assert.ok(functionCount.value > 0, "WASM code section contains a function.");
      bytes[size.next] ^= 1;
      return bytes;
    }
    offset = size.next + size.value;
  }
  throw new Error("WASM code section was not found.");
}

function runNodeGhdl(module, librariesTree, testCase) {
  const started = performance.now();
  let result;
  try {
    result = runGhdlSynth({
      module,
      librariesTree,
      files: testCase.files,
      top: testCase.top,
      standard: testCase.standard,
    });
  } catch (error) {
    console.error(`S0B_EXPECTED_FAILURE: tampered WASM failed during synthesis: ${error.message}`);
    return 1;
  }
  return { ...result, runMs: performance.now() - started };
}

function compareVerilog(result, expectedBytes) {
  const bytes = Buffer.from(result.verilog, "latin1");
  return { bytes, sha256: sha256(bytes), matches: bytes.equals(expectedBytes) };
}

function makeRow(environment, variant, testCase, repeat, order, compileMs, result, expected) {
  const compared = compareVerilog(result, expected.verilog);
  const row = {
    environment,
    variant,
    example_id: testCase.id,
    example: testCase.label,
    kind: testCase.kind,
    repeat,
    order,
    compile_ms: csvNumber(compileMs),
    run_ms: csvNumber(result.runMs),
    downstream_environment: testCase.kind === "board" ? "Chromium/WASI" : "",
    verilog_sha256: compared.sha256,
    verilog_match: compared.matches,
    memory_bytes: result.memoryBytes ?? "",
    fs_sha256: "",
    fs_match: "",
    synth_ms: "",
    pnr_ms: "",
    pack_ms: "",
    status: result.status === 0 && compared.matches ? "pass" : "fail",
    error: result.status === 0
      ? (compared.matches ? "" : "Verilog SHA-256 differs from native GHDL")
      : `${result.stage}: ${result.log}`,
    generatedVerilog: result.verilog,
    fsExpectedSha256: expected.fsSha256 ?? "",
  };
  return row;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function statistics(values) {
  const numbers = values.filter(Number.isFinite);
  if (numbers.length === 0) return null;
  const minimum = Math.min(...numbers);
  const maximum = Math.max(...numbers);
  return {
    median: median(numbers),
    min: minimum,
    max: maximum,
    range: maximum - minimum,
    count: numbers.length,
  };
}

function printSummary(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.environment, row.variant, row.example_id].join("\t");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  console.log("environment\tvariant\texample\tcompile_ms\tmedian_ms\tmin_ms\tmax_ms\trange_ms");
  for (const [key, group] of groups) {
    const stats = statistics(group.map((row) => Number(row.run_ms)));
    if (!stats) continue;
    const compileMs = Number(group[0].compile_ms);
    console.log(
      `${key}\t${compileMs.toFixed(3)}\t${stats.median.toFixed(3)}\t${stats.min.toFixed(3)}\t` +
      `${stats.max.toFixed(3)}\t${stats.range.toFixed(3)}`,
    );
  }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())
  );
  return port;
}

async function waitForServer(url, server) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`S0B server exited with status ${server.exitCode}.`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

function serializeBrowserCase(testCase) {
  return {
    ...testCase,
    files: testCase.files.map(({ path: filePath, content }) => ({
      path: filePath,
      contentBase64: Buffer.from(content).toString("base64"),
    })),
  };
}

async function startBrowser({ serverLogPath }) {
  const distRoot = path.join(root, "dist");
  const benchRoot = path.join(distRoot, "s0b");
  mkdirSync(benchRoot, { recursive: true });
  writeFileSync(
    path.join(benchRoot, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>S0B</title><script type="module" src="./page.mjs"></script>',
  );
  writeFileSync(
    path.join(benchRoot, "page.mjs"),
    `import { createBuildRunner } from "../lib/build-runner.mjs";
const runner = createBuildRunner();
const workers = new Map();
const decodeBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
globalThis.s0bReady = true;
globalThis.s0bCreateWorker = async (name, wasm, libraries) => {
  const worker = new Worker("./ghdl-worker.mjs", { type: "module" });
  workers.set(name, worker);
  const wasmBytes = decodeBase64(wasm);
  const libraryBytes = decodeBase64(libraries);
  const response = new Promise((resolve, reject) => {
    const onMessage = ({ data }) => {
      if (data.type !== "ready" && data.type !== "init-error") return;
      worker.removeEventListener("message", onMessage);
      data.type === "ready" ? resolve(data) : reject(new Error(data.message));
    };
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", (event) => reject(event.error ?? new Error(event.message)));
  });
  worker.postMessage(
    { type: "init", wasm: wasmBytes, libraries: libraryBytes },
    [wasmBytes.buffer, libraryBytes.buffer],
  );
  return response;
};
globalThis.s0bRun = (name, testCase) => new Promise((resolve, reject) => {
  const worker = workers.get(name);
  const onMessage = ({ data }) => {
    if (data.type !== "result" && data.type !== "run-error") return;
    worker.removeEventListener("message", onMessage);
    data.type === "result" ? resolve(data.result) : reject(new Error(data.message));
  };
  worker.addEventListener("message", onMessage);
  const prepared = {
    ...testCase,
    files: testCase.files.map(({ path, contentBase64 }) => ({
      path,
      content: decodeBase64(contentBase64),
    })),
  };
  worker.postMessage({ type: "run", testCase: prepared });
});
globalThis.s0bBuild = async ({ board, top, verilog, constraintPath, constraint }) => {
  const result = await runner.build({
    board,
    top,
    files: [
      { path: "src/top.v", content: verilog },
      { path: constraintPath, content: constraint },
    ],
  });
  const output = result.files.find(({ path }) => path === "build/top.fs");
  if (!output) throw new Error("Build runner did not produce build/top.fs");
  const digest = await crypto.subtle.digest("SHA-256", output.bytes);
  const fsSha256 = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { fsSha256, fsBytes: output.bytes.byteLength, timings: result.timings, memoryBytes: result.memoryBytes };
};
globalThis.s0bClose = () => {
  for (const worker of workers.values()) worker.terminate();
  runner.dispose();
};`,
  );
  writeFileSync(
    path.join(benchRoot, "ghdl-worker.mjs"),
    `import { runGhdlSynth } from "../lib/ghdl-host.mjs";
import { readUstar } from "../lib/ustar.mjs";
let module;
let librariesTree;
self.addEventListener("message", async ({ data }) => {
  if (data.type === "init") {
    try {
      const started = performance.now();
      module = await WebAssembly.compile(data.wasm);
      const compileMs = performance.now() - started;
      librariesTree = readUstar(data.libraries);
      self.postMessage({ type: "ready", compileMs });
    } catch (error) {
      self.postMessage({ type: "init-error", message: String(error?.message ?? error) });
    }
    return;
  }
  if (data.type !== "run") return;
  try {
    const started = performance.now();
    const result = runGhdlSynth({
      module,
      librariesTree,
      files: data.testCase.files,
      top: data.testCase.top,
      standard: data.testCase.standard,
    });
    self.postMessage({
      type: "result",
      result: { ...result, runMs: performance.now() - started },
    });
  } catch (error) {
    self.postMessage({ type: "run-error", message: String(error?.message ?? error) });
  }
});`,
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logFd = openSync(serverLogPath, "wx");
  const server = spawn("python3", ["dist/serve.py", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
  });
  let browser;
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/s0b/index.html`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => globalThis.s0bReady === true);
    return { browser, page, server, logFd, baseUrl };
  } catch (error) {
    await browser?.close();
    server.kill("SIGTERM");
    closeSync(logFd);
    throw error;
  }
}

async function stopBrowser(browserState) {
  if (!browserState) return;
  await browserState.page.evaluate(() => globalThis.s0bClose?.()).catch(() => {});
  await browserState.browser.close();
  browserState.server.kill("SIGTERM");
  closeSync(browserState.logFd);
}

async function compileNodeVariants(librariesTree) {
  const compiled = new Map();
  for (const variant of variants) {
    const wasm = readFileSync(variant.wasmPath);
    const started = performance.now();
    const module = await WebAssembly.compile(wasm);
    compiled.set(variant.name, {
      wasm,
      module,
      compileMs: performance.now() - started,
      librariesTree,
    });
  }
  return compiled;
}

async function compileBrowserVariants(page, librariesTar) {
  const compiled = new Map();
  for (const variant of variants) {
    const wasm = readFileSync(variant.wasmPath);
    const response = await page.evaluate(
      async ({ name, wasmBase64, libraryBase64 }) =>
        globalThis.s0bCreateWorker(name, wasmBase64, libraryBase64),
      {
        name: variant.name,
        wasmBase64: wasm.toString("base64"),
        libraryBase64: librariesTar.toString("base64"),
      },
    );
    compiled.set(variant.name, response.compileMs);
  }
  return compiled;
}

function runWarmups(environment, cases, compiled) {
  const order = ["Os", "B0"];
  for (const testCase of cases) {
    for (const variantName of order) {
      if (environment === "node") {
        const variant = compiled.get(variantName);
        runNodeGhdl(variant.module, variant.librariesTree, testCase);
      }
    }
  }
}

async function runBrowserWarmups(page, cases) {
  for (const testCase of cases) {
    for (const variantName of ["Os", "B0"]) {
      await page.evaluate(
        ({ name, testCase: input }) => globalThis.s0bRun(name, input),
        { name: variantName, testCase: serializeBrowserCase(testCase) },
      );
    }
  }
}

function failedResultRow(environment, variant, testCase, repeat, order, compileMs, error) {
  return {
    environment,
    variant,
    example_id: testCase.id,
    example: testCase.label,
    kind: testCase.kind,
    repeat,
    order,
    compile_ms: csvNumber(compileMs),
    run_ms: "",
    downstream_environment: testCase.kind === "board" ? "Chromium/WASI" : "",
    verilog_sha256: "",
    verilog_match: false,
    memory_bytes: "",
    fs_sha256: "",
    fs_match: "",
    synth_ms: "",
    pnr_ms: "",
    pack_ms: "",
    status: "fail",
    error: String(error?.stack ?? error),
  };
}

async function runNodeMeasurements(cases, expected, compiled, repeatsCount) {
  const rows = [];
  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeatsCount; repeat += 1) {
      const order = repeat % 2 === 1 ? ["Os", "B0"] : ["B0", "Os"];
      for (const variantName of order) {
        const variant = compiled.get(variantName);
        try {
          const result = runNodeGhdl(variant.module, variant.librariesTree, testCase);
          rows.push(makeRow(
            "node",
            variantName,
            testCase,
            repeat,
            order.join("->"),
            variant.compileMs,
            result,
            expected.get(testCase.id),
          ));
        } catch (error) {
          rows.push(failedResultRow(
            "node", variantName, testCase, repeat, order.join("->"), variant.compileMs, error,
          ));
        }
      }
    }
  }
  return rows;
}

async function runChromiumMeasurements(page, cases, compiled, expected, repeatsCount) {
  const rows = [];
  for (const testCase of cases) {
    for (let repeat = 1; repeat <= repeatsCount; repeat += 1) {
      const order = repeat % 2 === 1 ? ["Os", "B0"] : ["B0", "Os"];
      for (const variantName of order) {
        try {
          const result = await page.evaluate(
            ({ name, input }) => globalThis.s0bRun(name, input),
            { name: variantName, input: serializeBrowserCase(testCase) },
          );
          rows.push(makeRow(
            "chromium",
            variantName,
            testCase,
            repeat,
            order.join("->"),
            compiled.get(variantName),
            result,
            expected.get(testCase.id),
          ));
        } catch (error) {
          rows.push(failedResultRow(
            "chromium",
            variantName,
            testCase,
            repeat,
            order.join("->"),
            compiled.get(variantName),
            error,
          ));
        }
      }
    }
  }
  return rows;
}

async function addBoardPipelineTimings(page, rows, cases, expected) {
  const boardCasesById = new Map(cases.filter(({ kind }) => kind === "board").map((item) => [item.id, item]));
  for (const row of rows) {
    const testCase = boardCasesById.get(row.example_id);
    if (!testCase || row.status !== "pass") continue;
    try {
      const pipeline = await page.evaluate(
        (input) => globalThis.s0bBuild(input),
        {
          board: testCase.board,
          top: testCase.top,
          verilog: row.generatedVerilog,
          constraintPath: testCase.constraintPath,
          constraint: testCase.constraint,
        },
      );
      row.fs_sha256 = pipeline.fsSha256;
      row.fs_match = pipeline.fsSha256 === expected.get(testCase.id).fsSha256;
      row.synth_ms = csvNumber(pipeline.timings.synth);
      row.pnr_ms = csvNumber(pipeline.timings.pnr);
      row.pack_ms = csvNumber(pipeline.timings.pack);
      if (!row.fs_match) {
        row.status = "fail";
        row.error = "Browser .fs SHA-256 differs from native path";
      }
    } catch (error) {
      row.status = "fail";
      row.error = String(error?.stack ?? error);
    }
  }
}

function measureEnvironment() {
  const cpus = os.cpus();
  return {
    os: `${os.platform()} ${os.release()}`,
    cpu: cpus[0]?.model ?? "unknown",
    cpuCount: cpus.length,
    memoryBytes: os.totalmem(),
    node: process.version,
  };
}

function writeJson(pathname, value) {
  writeFileSync(pathname, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function printSixFixtureTotals(rows) {
  const sixIds = new Set(ghdlCases.slice(0, 6).map(({ id }) => id));
  console.log("six-fixture aggregate run_ms by repeat (S9B comparison subset):");
  for (const environment of ["node", "chromium"]) {
    for (const variant of ["Os", "B0"]) {
      const totals = [];
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const sample = rows.filter((row) =>
          row.environment === environment &&
          row.variant === variant &&
          row.repeat === repeat &&
          sixIds.has(row.example_id) &&
          row.status === "pass"
        );
        if (sample.length === sixIds.size) {
          totals.push(sample.reduce((sum, row) => sum + Number(row.run_ms), 0));
        }
      }
      const stats = statistics(totals);
      if (stats) {
        console.log(
          `${environment}\t${variant}\tmedian=${stats.median.toFixed(3)} ms\t` +
          `min=${stats.min.toFixed(3)} ms\tmax=${stats.max.toFixed(3)} ms\trange=${stats.range.toFixed(3)} ms`,
        );
      }
    }
  }
}

async function runTamperWasm() {
  const testCase = allCases()[0];
  const wasm = tamperWasmCode(readFileSync(variants[0].wasmPath));
  const librariesTree = readUstar(readFileSync(librariesTarPath));
  let module;
  try {
    module = await WebAssembly.compile(wasm);
  } catch (error) {
    console.error(`S0B_EXPECTED_FAILURE: tampered WASM was rejected: ${error.message}`);
    return 1;
  }
  const result = runGhdlSynth({
    module,
    librariesTree,
    files: testCase.files,
    top: testCase.top,
    standard: testCase.standard,
  });
  if (result.status === 0) {
    throw new Error("Tampered WASM unexpectedly synthesized successfully");
  }
  console.error(`S0B_EXPECTED_FAILURE: tampered WASM returned status ${result.status} at ${result.stage}`);
  return 1;
}

async function runTamperExpected() {
  const testCase = allCases()[0];
  const module = await WebAssembly.compile(readFileSync(variants[0].wasmPath));
  const librariesTree = readUstar(readFileSync(librariesTarPath));
  const native = nativeSynthesis(testCase);
  const tamperedExpected = Buffer.from(native);
  tamperedExpected[0] ^= 1;
  const result = runNodeGhdl(module, librariesTree, testCase);
  const comparison = compareVerilog(result, tamperedExpected);
  if (result.status !== 0) {
    throw new Error(`Expected-output control could not synthesize: ${result.stage}: ${result.log}`);
  }
  if (comparison.matches) throw new Error("Tampered native expected Verilog was not detected");
  console.error(
    `S0B_EXPECTED_FAILURE: tampered native expected Verilog detected; actual=${comparison.sha256}`,
  );
  return 1;
}

function verifyNegativeControl(name) {
  const scriptPath = fileURLToPath(import.meta.url);
  const logPath = path.join(root, "build/S0B", `negative-control-${name}.log`);
  const child = spawnSync(
    process.execPath,
    [scriptPath, `--tamper-${name}`],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  writeFileSync(logPath, output, { flag: "wx" });
  assert.notEqual(child.status, 0, `${name} negative-control run unexpectedly succeeded`);
  assert.match(output, /S0B_EXPECTED_FAILURE:/, `${name} did not fail for the expected reason:\n${output}`);
  console.log(`${name} negative control detected failure; log=${path.relative(root, logPath)}`);
}

async function verifyNegativeControls() {
  mkdirSync(path.join(root, "build/S0B"), { recursive: true });
  verifyNegativeControl("wasm");
  verifyNegativeControl("expected");
}

async function main() {
  const controlCount = Number(options["verify-negative-controls"]) +
    Number(options["tamper-wasm"]) + Number(options["tamper-expected"]);
  assert.ok(controlCount <= 1, "Choose only one negative-control mode.");
  if (options["verify-negative-controls"]) return verifyNegativeControls();
  if (options["tamper-wasm"]) return runTamperWasm();
  if (options["tamper-expected"]) return runTamperExpected();

  assert.ok(Number.isInteger(repeats) && repeats >= 5, "--repeats must be at least 5.");
  assert.ok(!existsSync(outputPath), `Output already exists; refusing to overwrite: ${outputPath}`);
  assert.ok(existsSync(nativeGhdl), `Native GHDL is missing: ${nativeGhdl}`);
  assert.ok(existsSync(librariesTarPath), `GHDL libraries archive is missing: ${librariesTarPath}`);
  for (const variant of variants) {
    assert.ok(existsSync(variant.wasmPath), `${variant.name} WASM is missing: ${variant.wasmPath}`);
  }
  const buildDirectory = path.join(root, "build/S0B");
  mkdirSync(buildDirectory, { recursive: true });
  const cases = allCases();
  const expected = loadNativeExpectations(cases);
  const librariesTar = readFileSync(librariesTarPath);
  const librariesTree = readUstar(librariesTar);
  const browserState = await startBrowser({
    serverLogPath: path.resolve(root, options["server-log"]),
  });
  let rows = [];
  let compiledNode;
  let compiledBrowser;
  let chromiumVersion;
  try {
    chromiumVersion = browserState.browser.version();
    compiledNode = await compileNodeVariants(librariesTree);
    compiledBrowser = await compileBrowserVariants(browserState.page, librariesTar);
    console.log(`Node ${process.version}; Chromium ${browserState.browser.version()}`);
    console.log(`Warm-up: one unrecorded run per variant and example; measured repeats=${repeats}.`);
    runWarmups("node", cases, compiledNode);
    await runBrowserWarmups(browserState.page, cases);
    const nodeRows = await runNodeMeasurements(cases, expected, compiledNode, repeats);
    const chromiumRows = await runChromiumMeasurements(
      browserState.page,
      cases,
      compiledBrowser,
      expected,
      repeats,
    );
    rows = [...nodeRows, ...chromiumRows];
    await addBoardPipelineTimings(browserState.page, rows, cases, expected);
  } finally {
    await stopBrowser(browserState);
  }

  for (const row of rows) {
    delete row.generatedVerilog;
    delete row.fsExpectedSha256;
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, csvText(rows), { flag: "wx" });
  const environment = measureEnvironment();
  const mergeBase = spawnSync(
    "git",
    ["merge-base", "HEAD", "origin/devin/1793380030-ghdl-ui"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(mergeBase.status, 0, `Could not determine S0B base commit: ${mergeBase.stderr}`);
  writeJson(path.join(buildDirectory, "environment.json"), {
    ...environment,
    chromium: chromiumVersion,
    baseCommit: mergeBase.stdout.trim(),
    measurementCommit: spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).stdout.trim(),
    variants: variants.map((variant) => {
      const wasm = readFileSync(variant.wasmPath);
      return { name: variant.name, wasmSha256: sha256(wasm), wasmBytes: wasm.byteLength };
    }),
    librariesSha256: sha256(librariesTar),
  });
  printSummary(rows);
  printSixFixtureTotals(rows);
  const failed = rows.filter((row) => row.status !== "pass");
  console.log(
    `S0B ${rows.length - failed.length}/${rows.length} rows passed; CSV=${path.relative(root, outputPath)}`,
  );
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (result) => {
    if (typeof result === "number") process.exitCode = result;
  },
  (error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  },
);
