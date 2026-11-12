import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { BOARDS } from "../web/lib/boards.mjs";
import { routeWorkerWithFakeUsb, stubPageUsb } from "../tests/e2e/fake-usb-helpers.mjs";

const root = path.resolve(import.meta.dirname, "..");
const options = parseArgs({
  options: {
    mode: { type: "string", default: "smoke" },
    manifest: { type: "string", default: "build/s7/variants.json" },
    out: { type: "string", default: "build/s7/chromium-smoke.csv" },
    repeats: { type: "string", default: "1" },
    case: { type: "string", default: "tangnano9k-sram" },
    variant: { type: "string", default: "all" },
    "tamper-expected": { type: "boolean", default: false },
    "tamper-fixture": { type: "boolean", default: false },
    "tamper-wasm": { type: "boolean", default: false },
  },
}).values;

const repeats = Number(options.repeats);
const manifestPath = path.resolve(root, options.manifest);
const outputPath = path.resolve(root, options.out);
const timeoutMs = 120_000;
const programmingCases = BOARDS.flatMap((board) => [
  { id: `${board.id}-sram`, board, target: "sram" },
  { id: `${board.id}-flash`, board, target: "flash" },
]);

function parseFsPayload(board, reverseByte = false) {
  const records = readFileSync(
    path.resolve(root, `build/fixtures/${board}.fs`),
    "ascii",
  )
    .split(/\r?\n/)
    .filter((line) => /^[01]+$/.test(line));
  const bytes = [];
  for (const record of records) {
    for (let offset = 0; offset < record.length; offset += 8) {
      let value = Number.parseInt(record.slice(offset, offset + 8), 2);
      if (reverseByte) {
        value = ((value & 0x55) << 1) | ((value >>> 1) & 0x55);
        value = ((value & 0x33) << 2) | ((value >>> 2) & 0x33);
        value = ((value & 0x0f) << 4) | ((value >>> 4) & 0x0f);
      }
      bytes.push(value);
    }
  }
  return Buffer.from(bytes);
}

function contentExpectation(testCase) {
  const payload = parseFsPayload(testCase.board.id, testCase.target === "sram");
  let kind;
  let bytes;
  let captureState;
  if (testCase.target === "sram") {
    kind = "sram";
    bytes = payload;
    captureState = { sramLength: payload.length };
  } else if (testCase.board.idcode === 0x0000081b) {
    kind = "nor";
    bytes = payload;
    captureState = { norLength: payload.length };
  } else {
    kind = "eflash";
    bytes = Buffer.concat([Buffer.from("GW1N"), Buffer.alloc(20, 0xff), payload]);
    captureState = { eflashLength: bytes.length };
  }
  if (options["tamper-expected"]) {
    bytes = Buffer.from(bytes);
    bytes[0] ^= 1;
  }
  return { kind, bytes, captureState };
}

function tamperFixture(source) {
  const lines = source.toString("ascii").split(/(\r?\n)/);
  for (let index = 0; index < lines.length; index += 2) {
    if (/^[01]+$/.test(lines[index])) {
      lines[index] = `${lines[index][0] === "0" ? "1" : "0"}${lines[index].slice(1)}`;
      return Buffer.from(lines.join(""), "ascii");
    }
  }
  throw new Error("Fixture contains no binary data record to corrupt.");
}

function readUleb(bytes, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: cursor };
  }
  throw new Error("Unexpected end of WASM section.");
}

function tamperWasmCode(source) {
  const bytes = Buffer.from(source);
  let sectionOffset = 8;
  while (sectionOffset < bytes.length) {
    const sectionId = bytes[sectionOffset];
    const sectionSize = readUleb(bytes, sectionOffset + 1);
    const payloadOffset = sectionSize.next;
    if (sectionId === 10) {
      const functionCount = readUleb(bytes, payloadOffset);
      assert.ok(functionCount.value > 0, "WASM code section contains a function.");
      bytes[payloadOffset] ^= 1;
      return bytes;
    }
    sectionOffset = payloadOffset + sectionSize.value;
  }
  throw new Error("WASM code section was not found.");
}

function csv(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, process) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Local server exited with status ${process.exitCode}.`);
    }
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}.`);
}

function loadManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.phase, "smoke");
  assert.deepEqual(
    manifest.variants.map((variant) => variant.name),
    ["B", "B2", "B+O3", "B+O3+LTOA", "B+LTOA"],
  );
  const variants = manifest.variants.map((variant) => ({
    ...variant,
    artifactDir: path.resolve(root, variant.artifact_dir),
    mjs: readFileSync(path.resolve(root, variant.artifact_dir, "openFPGALoader.mjs")),
    wasm: readFileSync(path.resolve(root, variant.artifact_dir, "openFPGALoader.wasm")),
  }));
  if (options.variant === "all") return variants;
  const selected = variants.filter((variant) => variant.name === options.variant);
  assert.equal(selected.length, 1, `Unknown variant: ${options.variant}`);
  return selected;
}

async function setupPage(browser, baseUrl, variant, captureState = null) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await stubPageUsb(page, false, { captureFakeUsbState: captureState !== null });
  const wasm = options["tamper-wasm"] ? tamperWasmCode(variant.wasm) : variant.wasm;
  await page.route("**/openFPGALoader.mjs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript",
      headers: { "Cross-Origin-Resource-Policy": "same-origin" },
      body: variant.mjs,
    }),
  );
  await page.route("**/openFPGALoader.wasm", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/wasm",
      headers: { "Cross-Origin-Resource-Policy": "same-origin" },
      body: wasm,
    }),
  );
  return { context, page, baseUrl };
}

async function runProgrammingCase(browser, baseUrl, variant, testCase) {
  const expectation = contentExpectation(testCase);
  const { context, page } = await setupPage(
    browser,
    baseUrl,
    variant,
    expectation.captureState,
  );
  const fixture = path.resolve(root, `build/fixtures/${testCase.board.id}.fs`);
  try {
    await routeWorkerWithFakeUsb(page, {
      idcode: testCase.board.idcode,
      captureState: expectation.captureState,
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#support-status").waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      () => document.querySelector("#project-status")?.textContent.trim() === "保存しました。",
      null,
      { timeout: 30_000 },
    );
    await page.locator("#board-select").selectOption(testCase.board.id);
    if (options["tamper-fixture"]) {
      await page.locator("#bitstream-file").setInputFiles({
        name: path.basename(fixture),
        mimeType: "text/plain",
        buffer: tamperFixture(readFileSync(fixture)),
      });
    } else {
      await page.locator("#bitstream-file").setInputFiles(fixture);
    }
    if (testCase.target === "flash") {
      await page.locator('input[name="target"][value="flash"]').check();
    }
    const button = page.locator("#program-button");
    await button.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForFunction(
      () => !document.querySelector("#program-button").disabled,
      null,
      { timeout: 30_000 },
    );
    const command = await page.locator("#command-preview").innerText();
    if (!command.includes(testCase.board.id)) {
      throw new Error(`Unexpected command preview: ${command}`);
    }

    const start = await page.evaluate(() => performance.now());
    await button.click();
    await page.waitForFunction(
      () => {
        const text = document.querySelector("#result-status")?.textContent ?? "";
        return text === "成功" || text.startsWith("失敗：");
      },
      null,
      { timeout: timeoutMs },
    );
    const elapsedMs = await page.evaluate((started) => performance.now() - started, start);
    const status = await page.locator("#result-status").innerText();
    const log = await page.locator("#program-log").innerText();
    const progress = await page.locator("#progress-bar").evaluate((element) => element.value);
    if (status !== "成功" || /\bFAIL\b/.test(log) || progress !== 100) {
      throw new Error(
        `Programming verification failed: status=${status}; progress=${progress}; log=${log}`,
      );
    }
    const contentResult = await page.evaluate(
      ({ kind, expectedBase64 }) => {
        const expected = Uint8Array.from(atob(expectedBase64), (char) => char.charCodeAt(0));
        const state = globalThis.__s7FakeUsbState;
        const rawActual = state?.[kind];
        const actual = rawActual ? new Uint8Array(rawActual.buffer ?? rawActual) : null;
        if (!actual) return { ok: false, reason: `missing ${kind} snapshot` };
        if (actual.length !== expected.length) {
          return {
            ok: false,
            reason: `${kind} length ${actual.length} != expected ${expected.length}`,
          };
        }
        for (let index = 0; index < expected.length; index += 1) {
          if (actual[index] !== expected[index]) {
            return {
              ok: false,
              reason: `${kind} mismatch at byte ${index}: ${actual[index]} != ${expected[index]}`,
            };
          }
        }
        return { ok: true, length: actual.length };
      },
      { kind: expectation.kind, expectedBase64: expectation.bytes.toString("base64") },
    );
    if (!contentResult.ok) {
      throw new Error(`Fake device content mismatch: ${contentResult.reason}`);
    }
    return {
      elapsedMs,
      details: `status=${status}; progress=${progress}; ${expectation.kind}=${contentResult.length}; command=${command}`,
    };
  } finally {
    await context.close();
  }
}

async function runInstantiate(browser, baseUrl, variant) {
  const { context, page } = await setupPage(browser, baseUrl, variant);
  try {
    await page.route("**/s7-instantiate-worker.js", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/javascript",
        headers: {
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
        body: readFileSync(path.resolve(root, "scripts/s7-instantiate-worker.js")),
      }),
    );
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    const result = await page.evaluate(async (timeout) => {
      const appScript = [...document.scripts].find((script) =>
        new URL(script.src, location.href).pathname.endsWith("/app.js"),
      );
      if (!appScript) throw new Error("Could not locate the application module URL.");
      const workerUrl = new URL("./s7-instantiate-worker.js", appScript.src);
      const worker = new Worker(workerUrl, { type: "module" });
      const started = performance.now();
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          worker.terminate();
          reject(new Error("Instantiate timeout."));
        }, timeout);
        worker.onmessage = ({ data }) => {
          clearTimeout(timer);
          worker.terminate();
          if (data.status !== "ready") reject(new Error(data.message ?? "Instantiate failed."));
          else resolve({ elapsedMs: performance.now() - started });
        };
        worker.onerror = (event) => {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(JSON.stringify({
            message: event.message,
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
            error: event.error ? String(event.error) : null,
            stack: event.error?.stack ?? null,
          })));
        };
        worker.postMessage({});
      });
    }, timeoutMs);
    return { elapsedMs: result.elapsedMs, details: "module load, compile, and instantiate ready" };
  } finally {
    await context.close();
  }
}

async function main() {
  if (!["smoke", "formal"].includes(options.mode)) {
    throw new Error("--mode must be smoke or formal.");
  }
  if (!Number.isInteger(repeats) || repeats < (options.mode === "formal" ? 5 : 1)) {
    throw new Error("Formal runs require at least 5 repeats; smoke requires at least 1.");
  }
  if (options.mode === "formal" && options.case !== "all") {
    throw new Error("Formal mode uses all eight programming cases and instantiate.");
  }
  if (options.mode === "formal" && options.variant !== "all") {
    throw new Error("Formal mode uses all five variants.");
  }
  if (
    options.mode === "formal"
    && (options["tamper-expected"] || options["tamper-fixture"] || options["tamper-wasm"])
  ) {
    throw new Error("Negative controls are smoke-only.");
  }
  if (options["tamper-fixture"] && options["tamper-wasm"]) {
    throw new Error("Only one negative control may run at a time.");
  }
  if (
    options.mode === "smoke"
    && options.case !== "instantiate"
    && !programmingCases.some((item) => item.id === options.case)
  ) {
    throw new Error(`Unknown smoke case: ${options.case}`);
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const outputFd = openSync(outputPath, "wx");
  closeSync(outputFd);

  const variants = loadManifest();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverLog = `${outputPath}.server.log`;
  const logFd = openSync(serverLog, "wx");
  const server = spawn("python3", ["dist/serve.py", "--port", String(port)], {
    cwd: root,
    stdio: ["ignore", logFd, logFd],
  });
  let browser;
  const rows = [];
  try {
    await waitForServer(baseUrl, server);
    browser = await chromium.launch({ headless: true });
    if (options.mode === "smoke") {
      const testCase = programmingCases.find((item) => item.id === options.case);
      for (const variant of variants) {
        try {
          const result = options.case === "instantiate"
            ? await runInstantiate(browser, baseUrl, variant)
            : await runProgrammingCase(browser, baseUrl, variant, testCase);
          rows.push({
            phase: "smoke",
            variant: variant.name,
            repeat: 1,
            case: options.case,
            status: "pass",
            elapsed_ms: "",
            details: result.details,
          });
          console.log(`${variant.name}: smoke PASS`);
        } catch (error) {
          rows.push({
            phase: "smoke",
            variant: variant.name,
            repeat: 1,
            case: options.case,
            status: "fail",
            elapsed_ms: "",
            details: error.stack ?? String(error),
          });
          console.error(`${variant.name}: smoke FAIL: ${error.message}`);
        }
      }
    } else {
      const cases = programmingCases;
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const offset = (repeat - 1) % variants.length;
        const order = [...variants.slice(offset), ...variants.slice(0, offset)];
        for (const testCase of cases) {
          for (const variant of order) {
            try {
              const result = await runProgrammingCase(browser, baseUrl, variant, testCase);
              rows.push({
                phase: "formal",
                variant: variant.name,
                repeat,
                case: testCase.id,
                status: "pass",
                elapsed_ms: result.elapsedMs.toFixed(3),
                details: result.details,
              });
            } catch (error) {
              rows.push({
                phase: "formal",
                variant: variant.name,
                repeat,
                case: testCase.id,
                status: "fail",
                elapsed_ms: "",
                details: error.stack ?? String(error),
              });
            }
          }
        }
        for (const variant of order) {
          try {
            const result = await runInstantiate(browser, baseUrl, variant);
            rows.push({
              phase: "formal",
              variant: variant.name,
              repeat,
              case: "instantiate",
              status: "pass",
              elapsed_ms: result.elapsedMs.toFixed(3),
              details: result.details,
            });
          } catch (error) {
            rows.push({
              phase: "formal",
              variant: variant.name,
              repeat,
              case: "instantiate",
              status: "fail",
              elapsed_ms: "",
              details: error.stack ?? String(error),
            });
          }
        }
      }
    }
  } finally {
    await browser?.close();
    server.kill("SIGTERM");
    closeSync(logFd);
  }

  const columns = ["phase", "variant", "repeat", "case", "status", "elapsed_ms", "details"];
  writeFileSync(
    outputPath,
    `${columns.join(",")}\n${rows.map((row) => columns.map((key) => csv(row[key])).join(",")).join("\n")}\n`,
  );
  const failures = rows.filter((row) => row.status !== "pass").length;
  console.log(`S7 ${options.mode}: ${rows.length - failures}/${rows.length} passed; ${options.out}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  },
);
