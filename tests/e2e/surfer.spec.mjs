import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const root = resolve(import.meta.dirname, "../..");
const fixture = readFileSync(resolve(root, "tests/fixtures/surfer/logic.vcd"), "utf8");

test.use({
  launchOptions: {
    args: ["--lang=ja-JP", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

async function openSurfer(page, vcd) {
  const requests = [];
  const messages = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (["http:", "https:"].includes(url.protocol)) {
      requests.push(url.href);
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
  await expect.poll(() => page.frames().some((frame) => /\/surfer\/(index\.html)?$/.test(frame.url()))).toBe(true);
  const frame = page.frames().find((candidate) => /\/surfer\/(index\.html)?$/.test(candidate.url()));
  assert.ok(frame);
  await frame.waitForFunction(() => typeof window.inject_message === "function", null, { timeout: 120_000 });
  await page.evaluate((contents) => {
    const iframe = document.querySelector("#surfer-frame");
    const bytes = Array.from(new TextEncoder().encode(contents));
    iframe.contentWindow.postMessage({ command: "InjectMessage",
      message: JSON.stringify({ LoadFromData: [bytes, "Clear"] }) }, window.location.origin);
  }, vcd);
  return { frame, messages, requests };
}

async function wavesLoaded(frame) {
  return frame.evaluate(async () => {
    const m = await import("/surfer/surfer.js");
    try {
      return m.waves_loaded();
    } catch {
      return false;
    }
  });
}

async function indexOfName(frame, name) {
  return frame.evaluate(async (signalName) => {
    const m = await import("/surfer/surfer.js");
    try {
      return m.index_of_name(signalName);
    } catch {
      return -1;
    }
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

test("loads VCD bytes without a blob fetch and exposes logic.clk", async ({ page }) => {
  const { frame, messages, requests } = await openSurfer(page, fixture);
  await expect.poll(() => messages.some((message) => message.includes("LoadFromData")), { timeout: 120_000 }).toBe(true);
  await expect.poll(() => wavesLoaded(frame), { timeout: 60_000 }).toBe(true);
  await addScope(frame, "logic");
  await expect.poll(() => indexOfName(frame, "logic.clk"), { timeout: 60_000 }).toBeGreaterThanOrEqual(0);
  expect(messages.some((message) => message.includes("Failed to parse wave file"))).toBe(false);
  expect(messages.some((message) => message.includes("Content Security Policy"))).toBe(false);
  const siteOrigin = new URL(page.url()).origin;
  expect(requests.filter((url) => !url.startsWith(`${siteOrigin}/`))).toEqual([]);
});

for (const [kind, contents] of [["corrupt", "not a VCD waveform"], ["empty", ""]]) {
test(`reports a parse error for a ${kind} VCD`, async ({ page }) => {
  const { frame, messages, requests } = await openSurfer(page, contents);
  await expect.poll(
    () => messages.some((message) => message.includes("Failed to parse wave file")),
    { timeout: 60_000 },
  ).toBe(true);
  const deadline = Date.now() + 1000;
  do {
    expect(await wavesLoaded(frame)).toBe(false);
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  const siteOrigin = new URL(page.url()).origin;
  expect(requests.filter((url) => !url.startsWith(`${siteOrigin}/`))).toEqual([]);
});
}

test("ships Surfer without Service Worker registration", async () => {
  const dist = resolve(root, "public_html/surfer");
  const html = readFileSync(resolve(dist, "index.html"), "utf8");
  expect(html).not.toMatch(/navigator\.serviceWorker\.register/);
  expect(existsSync(resolve(dist, "manifest.json"))).toBe(false);
  expect(existsSync(resolve(dist, "sw.js"))).toBe(false);
});
