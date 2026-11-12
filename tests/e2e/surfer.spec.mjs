import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixture = readFileSync(resolve(root, "tests/fixtures/surfer/logic.vcd"), "utf8");
const playwrightPort = process.env.PLAYWRIGHT_PORT ?? "8000";
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${playwrightPort}`;

test.use({
  launchOptions: {
    args: ["--lang=ja-JP", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

async function openSurfer(page, vcd) {
  const origin = new URL(baseURL).origin;
  const externalRequests = [];
  const messages = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
      externalRequests.push(url.href);
    }
  });
  page.on("console", (message) => messages.push(message.text()));
  await page.goto("/");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "surfer-frame";
    iframe.src = "/surfer/index.html";
    document.body.replaceChildren(iframe);
  });
  await expect.poll(() => page.frames().some((frame) => frame.url().endsWith("/surfer/index.html"))).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url().endsWith("/surfer/index.html"));
  assert.ok(frame);
  await frame.waitForFunction(() => typeof window.register_message_listener === "function");
  await page.evaluate((contents) => {
    const iframe = document.querySelector("#surfer-frame");
    const url = URL.createObjectURL(new Blob([contents], { type: "text/plain" }));
    iframe.contentWindow.postMessage({ command: "LoadUrl", url }, window.location.origin);
  }, vcd);
  return { frame, messages, externalRequests };
}

async function wavesLoaded(frame) {
  return frame.evaluate(async () => {
    const m = await import("/surfer/surfer.js");
    return m.waves_loaded();
  });
}

async function indexOfName(frame, name) {
  return frame.evaluate(async (signalName) => {
    const m = await import("/surfer/surfer.js");
    return m.index_of_name(signalName);
  }, name);
}

async function addScope(frame, scopeName) {
  await frame.evaluate(async (name) => {
    const m = await import("/surfer/surfer.js");
    m.inject_message(JSON.stringify({
      AddScope: [{ strs: [name], id: "None" }, false],
    }));
  }, scopeName);
}

test("loads a VCD from a same-origin blob URL and exposes logic.clk", async ({ page }) => {
  const { frame, messages, externalRequests } = await openSurfer(page, fixture);
  await expect.poll(() => messages.some((message) => message.includes("LoadWaveformFileFromUrl"))).toBe(true);
  await expect.poll(() => wavesLoaded(frame), { timeout: 5000 }).toBe(true);
  await addScope(frame, "logic");
  await expect.poll(() => indexOfName(frame, "logic.clk"), { timeout: 5000 }).toBeGreaterThanOrEqual(0);
  expect(messages.some((message) => message.includes("Failed to parse wave file"))).toBe(false);
  expect(externalRequests).toEqual([]);
});

test("reports a parse error for a corrupt VCD", async ({ page }) => {
  const { frame, messages, externalRequests } = await openSurfer(page, "not a VCD waveform");
  await expect.poll(
    () => messages.some((message) => message.includes("Failed to parse wave file")),
    { timeout: 5000 },
  ).toBe(true);
  const deadline = Date.now() + 1000;
  do {
    expect(await wavesLoaded(frame)).toBe(false);
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  expect(externalRequests).toEqual([]);
});

test("ships Surfer without Service Worker registration", async () => {
  const dist = resolve(root, "dist/surfer");
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  expect(html).not.toMatch(/navigator\.serviceWorker\.register/);
  expect(existsSync(resolve(dist, "manifest.json"))).toBe(false);
  expect(existsSync(resolve(dist, "sw.js"))).toBe(false);
});
