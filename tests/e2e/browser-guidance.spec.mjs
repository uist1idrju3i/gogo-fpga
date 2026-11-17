import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";

for (const feature of ["jspi", "wasm", "isolation"]) {
  test(`unsupported ${feature} shows specific guidance without crashing`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(feature => {
      Object.defineProperty(navigator, "usb", { value: { requestDevice() {} }, configurable: true });
      if (feature === "wasm") Object.defineProperty(globalThis, "WebAssembly", { value: undefined });
      if (feature === "jspi") Object.defineProperty(WebAssembly, "Suspending", { value: undefined });
      if (feature === "isolation") Object.defineProperty(globalThis, "crossOriginIsolated", { value: false });
    }, feature);
    await page.goto("/");
    await page.locator("#right-tab-write").click();
    const status = page.locator("#support-status");
    await expect(status).toContainText(feature === "wasm" ? "サイトの設定で WebAssembly を許可" : feature === "jspi" ? "Chrome 137 以降" : "COOP/COEP ヘッダー");
    if (feature !== "isolation") await expect(status).not.toContainText("localhost");
    await expect(page.locator("#program-button")).toBeDisabled();
    expect(errors).toEqual([]);
  });
}

for (const board of BOARDS) {
  test(`blocked WebGL keeps VCD downloadable and gives settings guidance for ${board.id}`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("gogo-fpga.welcome.dismissed", "true");
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return ["webgl", "webgl2", "experimental-webgl"].includes(type) ? null : getContext.call(this, type, ...args);
      };
    });
    await page.goto("/");
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#board-select").selectOption(board.id);
    await page.locator("#right-tab-verify").click();
    await page.locator("#simulation-button").click();
    await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
    await page.locator("#bottom-tab-waveform").click();
    await expect(page.locator("#waveform-status")).toContainText("サイトの設定で WebGL を許可");
    await expect(page.locator("#waveform-status")).toContainText("ハードウェア アクセラレーション");
    await expect(page.locator("#surfer-frame")).toHaveCount(0);
    const shots = resolve(homedir(), "shots");
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: resolve(shots, `browser-guidance-${board.id}.png`), fullPage: true });
    await page.locator("#bottom-tab-artifacts").click();
    await expect(page.locator("#wave-download-link")).toBeVisible();
  });
}
