import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";

for (const board of BOARDS) {
  test(`blink without assertions shows guidance for ${board.id}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("gogo-fpga.welcome.dismissed", "true"));
    await page.goto("/");
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#board-select").selectOption(board.id);
    await page.locator("#right-tab-verify").click();
    await page.locator("#formal-button").click();
    const status = page.locator("#formal-status");
    await expect(status).toContainText("検証対象が見つかりません。assert の性質を追加するか、性質に合うモードを選んでください。", { timeout: 120_000 });
    await expect(status).not.toContainText("ツールがエラーを返しました");
    await expect(status).toHaveAttribute("data-outcome", "failed");
    const shots = resolve(homedir(), "shots");
    mkdirSync(shots, { recursive: true });
    await status.scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(shots, `formal-no-targets-${board.id}.png`), fullPage: true });
    if (board.id === "tangnano9k") {
      await page.screenshot({ path: resolve(shots, "formal-no-targets.png"), fullPage: true });
    }
  });
}
