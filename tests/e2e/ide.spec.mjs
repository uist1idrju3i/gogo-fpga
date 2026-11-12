import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const screenshots = resolve(repoRoot, "build/screenshots/s4");
mkdirSync(screenshots, { recursive: true });

async function openIde(page) {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await expect(page.locator("#support-status")).toBeVisible();
}

async function editAndWaitForSave(page) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// 保存済み");
  await expect(page.locator("#project-status")).toHaveText(
    "保存しました。",
    { timeout: 10_000 },
  );
}

test("IDE loads without console errors and highlights Verilog keywords", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await openIde(page);
  const moduleToken = page
    .locator(".cm-content span")
    .filter({ hasText: /^module$/ })
    .first();
  await expect(moduleToken).toBeVisible();
  expect(await moduleToken.getAttribute("class")).toBeTruthy();
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  await expect(page.locator(".synthesis-reason")).toHaveText("");
  expect(
    await page
      .locator("#program-log")
      .evaluate((log) => getComputedStyle(log, "::before").content),
  ).toBe('"ログはまだありません。"');
  expect(errors).toEqual([]);
});

test("VHDL projects enable browser synthesis and select a language standard", async ({ page }) => {
  await openIde(page);
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill("zz-vhdl-enabled");
  await page.locator("#new-project-board").selectOption("tangnano1k");
  await page.locator("#new-project-language").selectOption("vhdl");
  await expect(page.locator("#new-project-standard-field")).toBeVisible();
  await page.locator("#new-project-standard").selectOption("2019");
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText("zz-vhdl-enabled");
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  await expect(page.locator("#synthesis-reason")).toHaveText("");
  await expect(page.locator("#vhdl-standard")).toBeVisible();
  await expect(page.locator("#vhdl-standard")).toHaveValue("2019");
});

test("syntax errors fail the build and appear in the problems panel", async ({
  page,
}) => {
  await openIde(page);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("module top(\nendmodule\n");
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 120_000,
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("top.v");
  await expect(page.locator("#problem-list")).toContainText("syntax");
  await page.screenshot({
    path: resolve(screenshots, "s4-syntax-error.png"),
  });
});

test("new project dialog shows board and HDL choices", async ({ page }) => {
  await openIde(page);
  await page.locator("#new-project-button").click();
  const dialog = page.locator("#new-project-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#new-project-board option")).toHaveCount(4);
  await expect(dialog.locator("#new-project-language option")).toHaveCount(2);
  await page.screenshot({
    path: resolve(screenshots, "ide-new-project.png"),
  });
});

test("Verilog autocomplete includes always", async ({ page }) => {
  await openIde(page);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("alw");
  await expect(page.locator(".cm-tooltip-autocomplete")).toContainText("always");
});

test("editor changes persist through reload from OPFS", async ({ page }) => {
  await openIde(page);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("module restored; endmodule");
  await expect(page.locator("#project-status")).toHaveText(
    "保存しました。",
    { timeout: 10_000 },
  );
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("module restored");
});

test("failed OPFS save displays an error", async ({ page }) => {
  await openIde(page);
  await expect(page.locator("#project-status")).toHaveText(
    "保存しました。",
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    Object.defineProperty(navigator.storage, "getDirectory", {
      configurable: true,
      value: async () => {
        throw new DOMException("保存に失敗しました。", "QuotaExceededError");
      },
    });
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// 保存失敗");
  await expect(page.locator("#project-status")).toHaveText(
    "プロジェクトを保存できません。",
    { timeout: 10_000 },
  );
  await expect(page.locator("#program-log")).toContainText("プロジェクト保存エラー");
});

test("file paths are validated with Japanese feedback", async ({ page }) => {
  await openIde(page);
  await expect(page.locator("#add-file-button")).not.toHaveClass(/secondary/);
  await expect(page.locator("#rename-file-button")).toHaveClass(/secondary/);
  await expect(page.locator("#delete-file-button")).toHaveClass(/secondary/);
  await expect(page.locator("#delete-file-button")).toHaveClass(/danger/);
  const actionHeights = await Promise.all(
    ["#add-file-button", "#rename-file-button", "#delete-file-button"].map((selector) =>
      page.locator(selector).evaluate((button) => button.getBoundingClientRect().height),
    ),
  );
  expect(new Set(actionHeights).size).toBe(1);
  await page.locator("#add-file-button").click();
  await page.locator("#file-path-input").fill("../x.v");
  await page.locator("#file-path-save").click();
  await expect(page.locator("#file-path-error")).toContainText("パス");
  await expect(page.locator("#file-dialog")).toBeVisible();

  await page.locator("#file-path-input").fill("src/a.vhd");
  await page.locator("#file-path-save").click();
  await expect(page.locator("#file-list")).toContainText("src/a.vhd");
  await expect(page.locator("#editor-tabs")).toContainText("a.vhd");
  await expect(page.locator(".editor-tab [role=tab][aria-selected=true]"))
    .toHaveAttribute("title", "src/a.vhd");
});

test("narrow layout opens and closes both side panes", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await openIde(page);
  const boardPicker = await page.locator('label[for="board-select"]').boundingBox();
  const headerActions = await page.locator(".header-actions").boundingBox();
  expect(headerActions.y).toBeGreaterThanOrEqual(boardPicker.y + boardPicker.height);
  await editAndWaitForSave(page);

  await expect(page.locator("#files-pane")).toBeHidden();
  await expect(page.locator("#toggle-files-pane")).toHaveText("ファイル一覧");
  await expect(page.locator("#toggle-files-pane")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#toggle-board-pane")).toHaveText("ボードと書き込み");
  await expect(page.locator("#toggle-board-pane")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#toggle-files-pane").click();
  await expect(page.locator("#files-pane")).toBeVisible();
  await expect(page.locator("#toggle-files-pane")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#close-files-pane").click();
  await expect(page.locator("#files-pane")).toBeHidden();
  await expect(page.locator("#toggle-files-pane")).toHaveAttribute("aria-expanded", "false");
  await page.locator("#toggle-board-pane").click();
  await expect(page.locator("#board-pane")).toBeVisible();
  await expect(page.locator("#toggle-board-pane")).toHaveAttribute("aria-expanded", "true");
  await page.locator("#close-board-pane").click();
  await expect(page.locator("#board-pane")).toBeHidden();
  await expect(page.locator("#toggle-board-pane")).toHaveAttribute("aria-expanded", "false");
  await page.screenshot({
    path: resolve(screenshots, "ide-narrow.png"),
  });
});

test("board screenshots show the selected FPGA and IDCODE", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openIde(page);
  const boards = [
    ["tangnano1k", "GW1NZ-1", "0x0100681B", "SRAM、内蔵フラッシュ"],
    ["tangnano4k", "GW1NSR-4C", "0x0100981B", "SRAM、内蔵フラッシュ"],
    ["tangnano9k", "GW1N(R)-9C", "0x0100481B", "SRAM、内蔵フラッシュ"],
    ["tangnano20k", "GW2A(R)-18(C)", "0x0000081B", "SRAM、外付け SPI フラッシュ"],
  ];
  for (const [id, fpga, idcode, targets] of boards) {
    const name = `screenshot-${id}`;
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(name);
    await page.locator("#new-project-board").selectOption(id);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-name")).toHaveText(name);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await expect(page.locator("#file-list")).toContainText(
      `constraints/${id}.cst`,
    );
    await expect(page.locator("#board-fpga")).toHaveText(fpga);
    await expect(page.locator("#board-idcode")).toHaveText(idcode);
    await expect(page.locator("#board-target")).toHaveText(targets);
    await expect(page.locator("#board-constraint-warning")).toBeHidden();
    await expect(page.locator(".cm-content")).not.toContainText("// 保存済み");
    await page.screenshot({
      path: resolve(screenshots, `ide-${id}.png`),
    });
  }
});

test("board changes show and hide a mismatched constraint warning", async ({
  page,
}) => {
  await openIde(page);
  const warning = page.locator("#board-constraint-warning");
  await expect(warning).toBeHidden();
  await page.locator("#board-select").selectOption("tangnano4k");
  await expect(warning).toHaveText(
    "この制約ファイル（constraints/tangnano1k.cst）は Tang Nano 1K 用です。ピン割り当ては T2 で編集できるようになります。",
  );
  await page.screenshot({
    path: resolve(screenshots, "ide-cst-mismatch.png"),
  });
  await page.locator("#board-select").selectOption("tangnano1k");
  await expect(warning).toBeHidden();
});

test("injected diagnostics show an editor marker and a Japanese problem row", async ({
  page,
}) => {
  await openIde(page);
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("toolchain:diagnostics", {
        detail: [{ from: 0, to: 6, severity: "error", message: "構文エラー" }],
      }),
    );
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("エラー: 構文エラー");
  await expect(page.locator(".cm-lintRange-error")).toBeVisible();
});
