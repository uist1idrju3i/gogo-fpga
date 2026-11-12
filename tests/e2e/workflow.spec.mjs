import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";
import { routeWorkerWithFakeUsb, stubPageUsb } from "./fake-usb-helpers.mjs";

const shots = resolve(process.env.U2_SCREENSHOT_DIR ?? "build/screenshots/u2a");
mkdirSync(shots, { recursive: true });

async function openProject(page, board = "tangnano9k") {
  await stubPageUsb(page);
  await page.goto("/");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(`u2a-${board}`);
  await page.locator("#new-project-board").selectOption(board);
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(`u2a-${board}`);
  await expect(page.locator("#synthesis-button")).toBeEnabled();
}

test("workflow uses real downloads, build, write, edits and cached rebuilds", async ({ page }) => {
  test.setTimeout(240_000);
  let workers = 0;
  await routeWorkerWithFakeUsb(page, { onWorkerRequest: () => { workers += 1; } });
  await openProject(page);
  await expect(page.locator("#validation-errors")).toBeHidden();
  await expect(page.locator(".brand .eyebrow")).toHaveCount(0);
  await page.evaluate(() => {
    window.__downloadMessages = [];
    new MutationObserver(() => window.__downloadMessages.push(document.querySelector("#synthesis-asset-size").textContent))
      .observe(document.querySelector("#synthesis-asset-size"), { childList: true });
  });
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", { timeout: 120_000 });
  expect(await page.evaluate(() => window.__downloadMessages.some((message) => /ツール取得:.*[\d.]+ \/ [\d.]+ MB/.test(message)))).toBe(true);
  await expect(page.locator("#program-button")).toBeEnabled();
  const bytes = await page.evaluate(async () => {
    const { createOpfsStore } = await import("/lib/project-store.mjs");
    const { files } = await createOpfsStore(navigator.storage).load("u2a-tangnano9k");
    return [...files.get("build/top.fs")];
  });
  writeFileSync(resolve("build/u2a-tangnano9k.fs"), Buffer.from(bytes));
  await expect(page.locator("#program-button")).toHaveCSS("background-color", "rgb(30, 107, 52)");
  await expect(page.locator("#synthesis-button")).toHaveClass(/secondary/);
  await expect(page.locator("[data-workflow-step]").nth(1)).toHaveText(/成功|警告/);
  await page.screenshot({ path: resolve(shots, "u2a-built.png") });
  await page.keyboard.press("Control+Enter");
  await expect(page.locator("#result-status")).toHaveText("成功", { timeout: 30_000 });
  await expect(page.locator("[data-workflow-step]").nth(3)).toHaveText("成功");

  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// revision\n");
  await expect(page.locator("#synthesis-button")).toHaveText("合成し直す");
  await expect(page.locator("#program-button")).toBeDisabled();
  await expect(page.locator("[data-workflow-step]").nth(1)).toHaveText("古い");
  await page.locator("#program-form").evaluate((form) => form.dispatchEvent(new Event("submit", { cancelable: true })));
  expect(workers).toBe(1);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: resolve(shots, "u2a-stale.png") });
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", { timeout: 120_000 });
  await expect(page.locator("#synthesis-asset-size")).toContainText("取得済み（キャッシュ）");
  await expect(page.locator("#program-button")).toBeEnabled();

  await page.reload();
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.locator("#project-select").selectOption("u2a-tangnano9k");
  await expect(page.locator("#project-name")).toHaveText("u2a-tangnano9k");
  await expect(page.locator("#synthesis-button")).toHaveText("合成し直す");
  await expect(page.locator("#program-button")).toBeDisabled();
  for (const worker of ["build-worker.js", "pack-worker.js"]) {
    await page.route(`**/${worker}`, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: `Object.defineProperty(globalThis, "caches", { value: undefined });\n${await response.text()}` });
    });
  }
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", { timeout: 120_000 });
  await expect(page.locator("#synthesis-asset-size")).not.toContainText("取得済み（キャッシュ）");
  await page.evaluate(() => {
    navigator.usb.requestDevice = () => new Promise((resolve) => { window.__resolveDevice = resolve; });
  });
  await page.locator("#program-button").click();
  await expect(page.locator("[data-workflow-step]").nth(3)).toHaveText("実行中");
  await page.locator("#board-select").selectOption("tangnano1k");
  await page.evaluate(() => window.__resolveDevice({ productName: "Tang Nano (test fake)" }));
  await expect(page.locator("#result-status")).toContainText("失敗：");
  await expect(page.locator("#workflow-guidance")).toContainText("合成し直してください");
  await expect(page.locator("#program-button")).toBeDisabled();
  expect(workers).toBe(1);
});

test("a failed first download can be retried, and a new build can be cancelled", async ({ page }) => {
  test.setTimeout(180_000);
  await openProject(page);
  await page.route("**/synth/yosys.wasm.zst", (route) => route.abort());
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗");
  await expect(page.locator("[data-workflow-step]").nth(1)).toHaveText("失敗");
  await page.unroute("**/synth/yosys.wasm.zst");
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-button")).toHaveText("中止");
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("中止しました");
  await expect(page.locator("#program-button")).toBeDisabled();
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", { timeout: 120_000 });
});

for (const board of BOARDS) {
  test(`workflow layout and focus targets: ${board.id}`, async ({ page }) => {
    await openProject(page, board.id);
    for (const width of [1280, 1024, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("#workflow-bar")).toContainText("編集");
      await expect(page.locator("#validation-errors")).toBeHidden();
      for (const id of ["synthesis-button", "simulation-button", "formal-button", "program-button", "board-select"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.locator("#synthesis-button").focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(page.locator("#synthesis-button")).toBeFocused();
      await expect(page.locator("#synthesis-button")).toHaveCSS("outline-style", "solid");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: resolve(shots, `u2a-${board.id}-${width}.png`) });
    }
  });
}
