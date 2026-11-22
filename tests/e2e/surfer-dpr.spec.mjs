import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

test.use({ launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] } });

async function simulate(page) {
  await page.goto("/");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.locator("#bottom-tab-waveform").click();
  const settings = page.getByRole("button", { name: "ボードと書き込みを開く", exact: true });
  if (await settings.isVisible()) await settings.click();
  await page.locator("#right-tab-verify").click();
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
  const close = page.locator("#close-board-pane");
  if (await close.isVisible()) await close.click();
  await expect(page.locator("#waveform-status")).toHaveText("波形を表示しています。");
  const frame = page.frames().find(frame => /\/surfer\/(index\.html)?$/.test(frame.url()));
  await expect.poll(() => frame.evaluate(async () => {
    const surfer = await import("/surfer/surfer.js");
    return surfer.index_of_name("top_tb.clk");
  })).toBeGreaterThanOrEqual(0);
  return frame;
}

async function recordZoom(page) {
  await page.addInitScript(() => {
    localStorage.setItem("gogo-fpga.welcome.dismissed", "true");
    globalThis.surferZoomMessages = [];
    addEventListener("message", ({ data }) => {
      if (data?.command !== "InjectMessage") return;
      const message = JSON.parse(data.message);
      if (message.SetUIZoomFactor) surferZoomMessages.push(message.SetUIZoomFactor);
    });
  });
}

test.describe("mobile DPR mismatch", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  test("waveform opened before simulation compensates for canvas/DPR divergence", async ({ page }) => {
    await recordZoom(page);
    await page.addInitScript(() => {
      if (window === parent) return;
      Object.defineProperty(ResizeObserverEntry.prototype, "devicePixelContentBoxSize", {
        get() { return this.contentBoxSize; },
      });
    });
    const shots = resolve(homedir(), "shots");
    mkdirSync(shots, { recursive: true });
    let compensate = false;
    await page.route("**/lib/surfer-scale.mjs", async route => {
      const response = await route.fetch();
      const original = await response.text();
      const body = compensate ? original : original.replace("if (ratio !== null)", "if (false)");
      await route.fulfill({ response, body });
    });
    await simulate(page);
    await page.locator("#surfer-frame").screenshot({ path: resolve(shots, "surfer-dpr-before.png") });
    compensate = true;
    const frame = await simulate(page);
    await expect.poll(() => frame.evaluate(() => surferZoomMessages.length)).toBeGreaterThan(0);
    const { ratio, zoom } = await frame.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return { ratio: canvas.width / (canvas.clientWidth * devicePixelRatio), zoom: surferZoomMessages.at(-1) };
    });
    expect(zoom).toBeCloseTo(ratio, 2);
    await page.locator("#surfer-frame").screenshot({ path: resolve(shots, "surfer-dpr-after.png") });
    const count = await frame.evaluate(() => surferZoomMessages.length);
    await page.evaluate(() => dispatchEvent(new Event("orientationchange")));
    await expect.poll(() => frame.evaluate(() => surferZoomMessages.length)).toBeGreaterThan(count);
  });
});

test("desktop DPR 1 never injects a zoom adjustment", async ({ page }) => {
  await recordZoom(page);
  const frame = await simulate(page);
  await page.setViewportSize({ width: 1200, height: 850 });
  await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await frame.evaluate(() => surferZoomMessages)).toEqual([]);
});
