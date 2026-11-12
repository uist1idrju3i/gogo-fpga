import { expect, test } from "@playwright/test";
import { prepareChat, previewAndSend, projectFile, proposalReply, slowChat } from "./ai-chat-helpers.mjs";

test("preview is inert, exposes exact bytes/history/headers, and every edit requires a new preview", async ({ page }) => {
  const requests = await prepareChat(page);
  await page.locator("#ai-prompt").fill("説明してください。");
  expect(requests).toHaveLength(0);
  await page.locator("#ai-preview-button").click();
  await expect(page.locator("#ai-preview-body")).toHaveAttribute("readonly", "");
  expect(await page.locator("#ai-preview-body").evaluate((element) => element.selectionStart)).toBe(0);
  expect(await page.locator("#ai-preview-body").evaluate((element) => element.scrollTop)).toBe(0);
  const first = await page.locator("#ai-preview-body").inputValue();
  const firstBody = JSON.parse(first);
  expect(firstBody.messages[0].content).toContain("gogo-fpga-changes");
  expect(JSON.parse(firstBody.messages.at(-1).content).files.map((f) => f.path)).toEqual(["src/top.v"]);
  await expect(page.locator("#ai-preview-headers")).toContainText("午後のFPGA");
  await expect(page.locator("#ai-preview-target")).toContainText(String(Buffer.byteLength(first)));
  expect(requests).toHaveLength(0);
  await page.locator("#ai-preview-cancel").click(); await page.locator("#ai-model").fill("test/model");
  await expect(page.locator("#ai-preview")).toBeHidden();
  await page.locator("#ai-preview-button").click();
  const sent = await page.locator("#ai-preview-body").inputValue();
  await page.locator("#ai-send").click(); await expect(page.locator("#ai-chat-response")).toHaveText("説明です。");
  expect(requests).toHaveLength(1); expect(requests[0].postDataBuffer()).toEqual(Buffer.from(sent));
  expect(requests[0].headers()["authorization"]).toBe("Bearer sk-or-chat-test-only");
  expect(requests[0].headers()["http-referer"]).toBe(new URL(page.url()).origin);
  await page.locator("#ai-prompt").fill("続けてください。"); await page.locator("#ai-preview-button").click();
  const next = JSON.parse(await page.locator("#ai-preview-body").inputValue());
  expect(next.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  await page.locator("#ai-clear").click(); await expect(page.locator("#ai-preview")).toBeHidden();
  await expect(page.locator("#ai-history-messages")).toBeEmpty();
});

test("selection edits and source edits invalidate the preview without any chat request", async ({ page }) => {
  const requests = await prepareChat(page);
  await page.locator("#ai-prompt").fill("確認してください。"); await page.locator("#ai-preview-button").click();
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.type("\n// preview invalidated");
  await expect(page.locator("#ai-preview")).toBeHidden(); expect(requests).toHaveLength(0);
  await page.locator("#ai-context-picker summary").click();
  await page.locator('#ai-context-files input[value="src/top.v"]').uncheck();
  await page.locator("#ai-preview-button").click();
  expect(JSON.parse(JSON.parse(await page.locator("#ai-preview-body").inputValue()).messages.at(-1).content).files).toEqual([]);
  expect(requests).toHaveLength(0);
});

test("streaming is visible, stop aborts, and partial fenced changes can never be applied", async ({ page }) => {
  await slowChat(page);
  await prepareChat(page, { reply: proposalReply([{ path: "src/top.v", content: "module changed; endmodule", reason: "test" }]) });
  const before = await projectFile(page);
  await page.locator("#ai-prompt").fill("変更を提案してください。"); await page.locator("#ai-preview-button").click(); await page.locator("#ai-send").click();
  await expect(page.locator("#ai-chat")).toHaveAttribute("data-state", "streaming");
  await expect(page.locator("#ai-chat-response")).toContainText("gogo-fpga-changes"); await expect(page.locator("#ai-proposals")).toBeHidden();
  await page.locator("#ai-stop").click(); await expect(page.locator("#ai-chat-error")).toContainText("停止しました");
  await expect(page.locator("#ai-proposals")).toBeHidden(); expect(await projectFile(page)).toBe(before);
});

test("per-file decisions, batch apply and undo preserve one revision and stale artifacts", async ({ page }) => {
  const changed = "module top(input clk, output led); assign led = clk; endmodule\n";
  await prepareChat(page, { reply: proposalReply([{ path: "src/top.v", content: changed, reason: "配線の例" }, { path: "tests/new.v", content: "module new_tb; endmodule\n", reason: "テストの例" }]) });
  const before = await projectFile(page);
  await page.locator("#synthesis-button").click(); await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", { timeout: 120000 });
  await previewAndSend(page, "変更を提案してください。");
  await expect(page.locator(".ai-proposal pre").first()).toContainText("@@");
  await page.locator('.ai-proposal[data-path="tests/new.v"] button').filter({ hasText: "却下" }).click();
  expect(await projectFile(page, "tests/new.v")).toBeNull();
  await page.locator('.ai-proposal[data-path="src/top.v"] button').filter({ hasText: "この変更を適用" }).click();
  expect(await projectFile(page)).toBe(before);
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.evaluate(() => {
    const original = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (...args) {
      if (this.name === "workspace.zip" && !window.__aiSavePaused) {
        window.__aiSavePaused = true;
        await new Promise((resolve) => { window.__releaseAiSave = resolve; });
      }
      return original.apply(this, args);
    };
  });
  await page.locator("#right-tab-verify").click();
  await page.locator("#simulation-top").fill("top_tb_for_busy_check");
  await page.locator("#right-tab-ai").click();
  await page.waitForFunction(() => window.__aiSavePaused);
  await expect(page.locator("#ai-apply-selected")).toBeDisabled();
  await page.evaluate(() => window.__releaseAiSave());
  await expect(page.locator("#ai-apply-selected")).toBeEnabled();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了");
  await page.locator("#ai-apply-selected").click();
  await expect(page.locator("#synthesis-button")).toHaveText("合成し直す");
  await expect(page.locator("[data-workflow-step]").nth(1)).toContainText("古い");
  await expect(page.locator("#program-button")).toBeDisabled(); expect(await projectFile(page)).toBe(changed);
  expect(await projectFile(page, "tests/new.v")).toBeNull();
  await page.locator("#ai-undo").click(); await expect(page.locator("#ai-undo")).toBeHidden(); expect(await projectFile(page)).toBe(before);
});

test("malicious paths are visible and cannot be selected or applied", async ({ page }) => {
  await prepareChat(page, { reply: proposalReply([{ path: "../secret.v", content: "bad" }, { path: "constraints/tangnano9k.cst", content: "bad pins" }, { path: "libraries/demo/sources/x.v", content: "bad library" }]) });
  const before = await projectFile(page); await previewAndSend(page);
  await expect(page.locator("#ai-rejected-paths")).toContainText("適用できないパス");
  await expect(page.locator("#ai-rejected-paths")).toContainText("ピン設定");
  await expect(page.locator("#ai-proposals")).toBeHidden(); expect(await projectFile(page)).toBe(before);
});

test("changed files block applying a previously received proposal", async ({ page }) => {
  await prepareChat(page, { reply: proposalReply([{ path: "src/top.v", content: "module changed; endmodule", reason: "test" }]) });
  await previewAndSend(page);
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+End"); await page.keyboard.type("\n// keep this edit");
  await page.locator(".ai-proposal button").filter({ hasText: "この変更を適用" }).click(); await page.locator("#ai-apply-selected").click();
  await expect(page.locator("#ai-chat-error")).toContainText("送信後にファイルが変わりました");
  await expect(page.locator(".cm-content")).toContainText("keep this edit");
});

test("build failure offers explanation with the problem, source and tool log but never sends automatically", async ({ page }) => {
  const requests = await prepareChat(page);
  await page.locator(".cm-content").click(); await page.keyboard.press("Control+A"); await page.keyboard.type("module top; invalid syntax\n");
  await page.locator("#synthesis-button").click(); await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", { timeout: 120000 });
  await page.locator("#bottom-tab-problems").click();
  await page.locator("#ai-explain-build").click();
  expect(await page.locator("#ai-prompt").inputValue()).toContain("原因と修正案");
  await page.locator("#ai-preview-button").click();
  const body = JSON.parse(await page.locator("#ai-preview-body").inputValue()); const context = JSON.parse(body.messages.at(-1).content);
  expect(context.problems.length).toBeGreaterThan(0); expect(context.logs.length).toBeGreaterThan(0); expect(context.files.map((f) => f.path)).toContain("src/top.v");
  await page.locator("#ai-preview-cancel").click();
  await page.locator("#problem-list").getByRole("button", { name: "エラーを AI に説明してもらう", exact: true }).first().click();
  await expect(page.locator("#ai-prompt")).toHaveValue(/原因と修正案/);
  await page.locator("#ai-preview-button").click();
  const problemContext = JSON.parse(JSON.parse(await page.locator("#ai-preview-body").inputValue()).messages.at(-1).content);
  expect(problemContext.problems).toHaveLength(1); expect(problemContext.logs.length).toBeGreaterThan(0);
  expect(requests).toHaveLength(0);
});

test("provider failures never disclose keys and disconnect clears the memory-only conversation", async ({ page }) => {
  await prepareChat(page, { status: 401 });
  await page.locator("#ai-prompt").fill("help"); await page.locator("#ai-preview-button").click(); await page.locator("#ai-send").click();
  await expect(page.locator("#ai-chat-error")).toContainText("接続し直してください");
  expect(await page.locator("#right-panel-ai").textContent()).not.toContain("sk-or-chat-test-only");
  await page.locator("#ai-disconnect").click(); await expect(page.locator("#ai-prompt")).toHaveValue(""); await expect(page.locator("#ai-chat-error")).toBeHidden();
});
