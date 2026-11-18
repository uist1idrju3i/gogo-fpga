import { expect, test } from "@playwright/test";
import { prepareChat, previewAndSend, projectFile, proposalReply, slowChat } from "./ai-chat-helpers.mjs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { MAX_MODELS_BYTES, MODELS_URL } from "../../web/lib/openrouter-models.mjs";

const modelCatalog = { data: [
  { id: "example/paid", context_length: 32768, pricing: { prompt: "0.0000025", completion: "0.00001" }, supported_parameters: ["tools", "structured_outputs"] },
  { id: "example/tiny", context_length: 10, pricing: { prompt: "0", completion: "-1" }, supported_parameters: ["reasoning"] },
] };

test("hashing blocks previews and clearing does not repopulate history", async ({ page }) => {
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const throwIfAborted = AbortSignal.prototype.throwIfAborted;
    AbortSignal.prototype.throwIfAborted = function () {
      if (window.historyWasCleared) window.postClearAbortChecks++;
      return throwIfAborted.call(this);
    };
    crypto.subtle.digest = async (...args) => {
      if (document.querySelector("#ai-usage")?.textContent && args[0] === "SHA-256") {
        window.historyHashStarted = true;
        await new Promise(resolve => { window.releaseHistoryHash = resolve; });
      }
      const result = await digest(...args);
      if (window.historyHashStarted) window.historyHashFinished = true;
      return result;
    };
  });
  await prepareChat(page);
  await page.locator("#ai-prompt").fill("説明してください。");
  await page.locator("#ai-preview-button").click();
  await page.locator("#ai-send").click();
  await expect.poll(() => page.evaluate(() => window.historyHashStarted)).toBe(true);
  await expect(page.locator("#ai-chat-response")).toHaveText("説明です。");
  await expect(page.locator("#ai-usage")).toHaveText("使用量は返されませんでした");
  await expect(page.locator("#ai-preview-button")).toBeDisabled();
  await page.evaluate(() => document.querySelector("#ai-preview-button").dispatchEvent(new MouseEvent("click")));
  await expect(page.locator("#ai-chat")).not.toHaveAttribute("data-state", "previewing");
  await page.locator("#ai-clear").click();
  await page.evaluate(() => { window.historyWasCleared = true; window.postClearAbortChecks = 0; window.releaseHistoryHash(); });
  await expect.poll(() => page.evaluate(() => window.historyHashFinished)).toBe(true);
  expect(await page.evaluate(() => window.postClearAbortChecks)).toBe(0);
  await expect(page.locator("#ai-history-messages")).toBeEmpty();
  await expect(page.locator("#ai-resend-history-option")).toBeHidden();
  await page.locator("#ai-prompt").fill("新しい相談です。");
  await page.locator("#ai-preview-button").click();
  const body = JSON.parse(await page.locator("#ai-preview-body").inputValue());
  expect(body.messages).toHaveLength(2);
});

async function mockModels(page, { body = JSON.stringify(modelCatalog), headers = {} } = {}) {
  const requests = [];
  await page.route(MODELS_URL, async route => {
    requests.push(route.request());
    await route.fulfill({ contentType: "application/json", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin, ...headers }, body });
  });
  return requests;
}

for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
  test(`structured preview, response, apply and raw history for ${board}`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    const changed = "module top(input clk, output led); assign led = clk; endmodule\n";
    const reply = JSON.stringify({ answer: "クロックを出力へ接続する提案です。適用前に差分を確認してください。", changes: [{ path: "src/top.v", content: changed, reason: "配線の例" }] });
    await slowChat(page);
    const requests = await prepareChat(page, { reply });
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(`structured-${board}`);
    await page.locator("#new-project-board").selectOption(board);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#right-tab-ai").click();
    await mockModels(page);
    await page.locator("#ai-models-fetch").click();
    await expect(page.locator("#ai-models-status")).toContainText("2件");
    await page.locator("#ai-model").fill("example/paid");
    await page.locator("#ai-skill").selectOption("change");
    await page.locator("#ai-prompt").fill("変更を提案してください。");
    await page.locator("#ai-preview-button").click();
    await expect(page.locator("#ai-output-mode")).toContainText("構造化出力を使います");
    const body = await page.locator("#ai-preview-body").inputValue();
    expect(JSON.parse(body).response_format.json_schema.strict).toBe(true);
    expect(JSON.parse(body).provider).toEqual({ require_parameters: true });
    await page.locator("#ai-output-mode").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-structured-preview-${board}.png`) });
    await page.locator("#ai-send").click();
    await expect(page.locator("#ai-chat-response")).toHaveText("構造化された応答を受信しています");
    await expect(page.locator("#ai-chat")).toHaveAttribute("data-state", "proposal_review");
    expect(requests[0].postData()).toBe(body);
    await expect(page.locator("#ai-chat-response")).toHaveText(JSON.parse(reply).answer);
    await expect(page.locator(".ai-proposal")).toHaveCount(1);
    await page.locator("#ai-answer").evaluate(element => element.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-structured-answer-${board}.png`) });
    const before = await projectFile(page);
    await page.locator(".ai-proposal button").filter({ hasText: "この変更を適用" }).click();
    await page.locator("#ai-apply-selected").click();
    await expect.poll(() => projectFile(page)).toBe(changed);
    await page.locator("#ai-undo").click();
    await expect(page.locator("#ai-undo")).toBeHidden();
    await expect.poll(() => projectFile(page)).toBe(before);
    await page.locator("#ai-prompt").fill("続けて説明してください。");
    await page.locator("#ai-preview-button").click();
    const next = JSON.parse(await page.locator("#ai-preview-body").inputValue());
    expect(next.messages.find(message => message.role === "assistant").content).toBe(reply);
  });
}

test("malformed structured reply cannot apply, unsupported model keeps fence path", async ({ page }) => {
  const raw = '{"answer":"説明","changes":[],"extra":true}';
  const requests = await prepareChat(page, { reply: raw });
  await mockModels(page);
  await page.locator("#ai-models-fetch").click();
  await expect(page.locator("#ai-models-status")).toContainText("2件");
  await page.locator("#ai-model").fill("example/paid");
  await page.locator("#ai-skill").selectOption("change");
  await previewAndSend(page);
  await expect(page.locator("#ai-chat-response")).toHaveText(raw);
  await expect(page.locator("#ai-rejected-paths")).toContainText("提案の JSON を確認できません");
  await expect(page.locator("#ai-apply-selected")).toBeDisabled();
  await expect(page.locator(".ai-proposal")).toHaveCount(0);
  await page.locator("#ai-clear").click();
  await page.locator("#ai-model").fill("example/tiny");
  const changed = "module top; endmodule\n";
  await page.route("https://openrouter.ai/api/v1/chat/completions", route => route.fulfill({
    contentType: "text/event-stream", headers: { "Access-Control-Allow-Origin": new URL(page.url()).origin },
    body: `data: ${JSON.stringify({ choices: [{ delta: { content: proposalReply([{ path: "src/top.v", content: changed, reason: "例" }]) } }] })}\n\ndata: [DONE]\n\n`,
  }));
  await page.locator("#ai-prompt").fill("提案してください。");
  await page.locator("#ai-preview-button").click();
  await expect(page.locator("#ai-output-mode")).toContainText("構造化出力を使いません");
  const body = await page.locator("#ai-preview-body").inputValue();
  expect(Object.keys(JSON.parse(body))).toEqual(["model", "stream", "messages"]);
  expect(JSON.parse(body).messages[0].content).toContain("gogo-fpga-changes");
  const sent = page.waitForRequest("https://openrouter.ai/api/v1/chat/completions");
  await page.locator("#ai-send").click();
  expect((await sent).postData()).toBe(body);
  await expect(page.locator(".ai-proposal")).toHaveCount(1);
  expect(requests).toHaveLength(1);
});

for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
  test(`compact history and explicit full resend for ${board}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const requests = await prepareChat(page);
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(`history-${board}`);
    await page.locator("#new-project-board").selectOption(board);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-name")).toHaveText(`history-${board}`);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#right-tab-ai").click();
    await expect(page.locator("#ai-resend-history-option")).toBeHidden();
    const first = await previewAndSend(page);
    const earlier = JSON.parse(JSON.parse(first).messages.at(-1).content);
    expect(earlier.files.length).toBeGreaterThan(0);
    expect(requests[0].postData()).toBe(first);
    await expect(page.locator("#ai-resend-history")).not.toBeChecked();
    await page.locator("#ai-resend-history-option").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-history-${board}.png`) });
    const second = await previewAndSend(page, "続けて説明してください。");
    const old = JSON.parse(JSON.parse(second).messages[1].content);
    expect(old.files[0]).toEqual({ path: earlier.files[0].path, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), bytes: Buffer.byteLength(earlier.files[0].content) });
    expect(old.files.every(file => !Object.hasOwn(file, "content"))).toBe(true);
    expect(requests[1].postData()).toBe(second);
    await page.locator("#ai-resend-history").check();
    const third = await previewAndSend(page, "全文も確認してください。");
    expect(JSON.parse(JSON.parse(third).messages[1].content)).toEqual(earlier);
    expect(requests[2].postData()).toBe(third);
  });
  test(`explicit model metadata and context estimate for ${board}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const allModelRequests = [];
    page.on("request", request => { if (request.url() === MODELS_URL) allModelRequests.push(request); });
    const chats = await prepareChat(page);
    const requests = await mockModels(page);
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(`models-${board}`);
    await page.locator("#new-project-board").selectOption(board);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-name")).toHaveText(`models-${board}`);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#right-tab-ai").click();
    await page.locator("#ai-model").fill("example/paid");
    await expect(page.locator("#ai-model-details")).toBeHidden();
    expect(requests).toHaveLength(0); expect(allModelRequests).toHaveLength(0);
    await page.locator("#ai-models-fetch").click();
    await expect(page.locator("#ai-models-status")).toContainText("2件");
    expect(requests).toHaveLength(1);
    expect(requests[0].method()).toBe("GET");
    expect(requests[0].headers().authorization).toBeUndefined();
    expect(requests[0].headers().referer).toBeUndefined();
    expect(requests[0].headers().cookie).toBeUndefined();
    expect(await page.locator("#ai-model-options option").evaluateAll(options => options.map(option => option.value))).toEqual(["example/paid", "example/tiny"]);
    await expect(page.locator("#ai-model-details")).toContainText("32768 トークン");
    await expect(page.locator("#ai-model-details")).toContainText("入力 $2.5 / 出力 $10");
    await expect(page.locator("#ai-model-details")).toContainText("構造化出力: 対応・ツール: 対応・推論: 非対応");
    await page.locator("#ai-model").fill("unknown/model");
    await expect(page.locator("#ai-model-details")).toHaveText("一覧にないモデルです");
    await page.locator("#ai-model").fill("example/tiny");
    await expect(page.locator("#ai-model-details")).toContainText("入力 無料 / 出力 不明");
    await expect(page.locator("#ai-model-details")).toContainText("推論: 対応");
    await page.locator("#ai-model-details").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-models-${board}.png`) });
    await page.locator("#ai-prompt").fill("この設計を説明してください。");
    await page.locator("#ai-preview-button").click();
    const body = await page.locator("#ai-preview-body").inputValue();
    await expect(page.locator("#ai-token-estimate")).toContainText(`推定 ${Buffer.byteLength(body)} トークン`);
    await expect(page.locator("#ai-context-warning")).toBeVisible();
    await page.locator("#ai-context-warning").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-models-context-${board}.png`) });
    expect(requests).toHaveLength(1); expect(chats).toHaveLength(0);
    await page.locator("#ai-preview-cancel").click();
    await page.locator("#ai-model").fill("example/paid");
    await page.locator("#ai-preview-button").click();
    await expect(page.locator("#ai-context-warning")).toBeHidden();
    expect(requests).toHaveLength(1);
    await page.reload(); await page.locator("#right-tab-ai").click();
    await expect(page.locator("#ai-model-options option")).toHaveCount(0);
    await expect(page.locator("#ai-model-details")).toBeHidden();
    expect(requests).toHaveLength(1);
  });
  test(`response usage accounting for ${board}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    await prepareChat(page, { usage: { prompt_tokens: 120, completion_tokens: 30, cost: 0.00042,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 10 } } });
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(`usage-${board}`);
    await page.locator("#new-project-board").selectOption(board);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-name")).toHaveText(`usage-${board}`);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#right-tab-ai").click();
    await previewAndSend(page);
    await expect(page.locator("#ai-usage")).toHaveText("入力 120 トークン（キャッシュ 40）・出力 30 トークン（推論 10）・費用 $0.00042");
    await page.locator("#ai-usage").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-usage-${board}.png`) });
    await page.locator("#ai-clear").click();
    await expect(page.locator("#ai-usage")).toBeEmpty();
  });
  test(`AI skill selector and project summary for ${board}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1100 });
    const requests = await prepareChat(page);
    await page.locator("#new-project-button").click();
    await page.locator("#new-project-name").fill(`ai-${board}`);
    await page.locator("#new-project-board").selectOption(board);
    await page.locator("#new-project-create").click();
    await expect(page.locator("#project-name")).toHaveText(`ai-${board}`);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.locator("#right-tab-ai").click();
    await expect(page.locator("#ai-skill")).toHaveValue("consult");
    await expect(page.locator("#ai-skill option")).toHaveCount(6);
    await page.locator("#ai-skill").scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-skill-${board}.png`) });
    await page.locator("#ai-skill").selectOption("formal");
    await page.locator("#ai-prompt").fill("性質を提案してください。");
    await page.locator("#ai-preview-button").click();
    const body = JSON.parse(await page.locator("#ai-preview-body").inputValue());
    const user = JSON.parse(body.messages.at(-1).content);
    expect(user.skill).toBe("formal");
    expect(user.project.board.id).toBe(board);
    expect(user.project.files.every(file => !Object.hasOwn(file, "content"))).toBe(true);
    expect(requests).toHaveLength(0);
  });
}

for (const [name, response, message] of [
  ["oversized", { body: " ".repeat(MAX_MODELS_BYTES + 1) }, "モデル一覧が大きすぎるため破棄しました。"],
  ["invalid shape", { body: '{"data":[{"id":"safe"},null]}' }, "モデル一覧を取得できませんでした。"],
  ["invalid JSON", { body: "not JSON" }, "モデル一覧を取得できませんでした。"],
  ["empty", { body: '{"data":[]}' }, "0件のモデルを取得しました。"],
]) {
  test(`model catalog ${name} fails closed or reports empty`, async ({ page }) => {
    await prepareChat(page);
    const requests = await mockModels(page, response);
    await page.locator("#ai-models-fetch").click();
    await expect(page.locator("#ai-models-status")).toContainText(message);
    await expect(page.locator("#ai-model-options option")).toHaveCount(0);
    if (name === "empty") await expect(page.locator("#ai-model-details")).toHaveText("一覧にないモデルです");
    else await expect(page.locator("#ai-model-details")).toBeHidden();
    expect(requests).toHaveLength(1);
  });
}

test("a failed refresh discards previously valid model metadata and suggestions", async ({ page }) => {
  await prepareChat(page);
  await mockModels(page);
  await page.locator("#ai-models-fetch").click();
  await expect(page.locator("#ai-model-options option")).toHaveCount(2);
  await mockModels(page, { body: "{}" });
  await page.locator("#ai-models-fetch").click();
  await expect(page.locator("#ai-models-status")).toContainText("モデル一覧を取得できませんでした。");
  await expect(page.locator("#ai-model-options option")).toHaveCount(0);
  await expect(page.locator("#ai-model-details")).toBeHidden();
});

test("connection comes first, disconnected chat collapses, and mobile diffs scroll above the action bar", async ({ page }) => {
  await prepareChat(page, { reply: proposalReply([{ path: "src/top.v", content: `module top; // ${"long line ".repeat(80)}\nendmodule\n` }]) });
  expect(await page.locator("#ai-auth-status").evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector("#ai-chat")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect(await page.locator("#ai-disconnect").evaluate((element) => Boolean(element.compareDocumentPosition(document.querySelector("#ai-chat")) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.locator("#toggle-board-pane").click();
  await previewAndSend(page);
  const diff = page.locator(".ai-diff").first();
  await expect(diff).not.toContainText("Index:");
  await expect(diff).not.toContainText("====");
  await expect(diff).toHaveCSS("white-space", "pre");
  await expect(diff.locator(".ai-diff-added").first()).toContainText("+module top;");
  await expect(diff.locator(".ai-diff-removed").first()).toContainText("-");
  await expect(diff.locator(".ai-diff-hunk").first()).toContainText("@@");
  for (const [selector, color] of [[".ai-diff-added", "rgb(220, 252, 231)"], [".ai-diff-removed", "rgb(254, 226, 226)"], [".ai-diff-hunk", "rgb(226, 232, 240)"]]) {
    await expect(diff.locator(selector).first()).toHaveCSS("background-color", color);
  }
  expect(await diff.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await diff.evaluate((element) => { element.scrollLeft = 200; });
  expect(await diff.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.locator(".ai-proposal button").first().click();
  await page.locator(".header-actions").evaluate((element) => { element.style.paddingTop = "90px"; });
  await expect.poll(async () => {
    const sheet = await page.locator("#board-pane").boundingBox(), bar = await page.locator(".header-actions").boundingBox();
    return sheet.y + sheet.height <= bar.y;
  }).toBe(true);
  const apply = page.locator("#ai-apply-selected");
  await apply.scrollIntoViewIfNeeded();
  const button = await apply.boundingBox(), bar = await page.locator(".header-actions").boundingBox();
  expect(button.y + button.height).toBeLessThanOrEqual(bar.y);
  expect(await apply.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.bottom - 2));
  })).toBe(true);
  await page.locator("#ai-disconnect").click();
  await expect(page.locator("#ai-chat-status")).toHaveText("接続すると使えます");
  await expect(page.locator("#ai-compose")).toBeHidden();
  await expect(page.locator("#ai-history")).toBeHidden();
  await expect(page.locator("#ai-clear")).toBeHidden();
  await expect(page.locator("#ai-connect")).toBeVisible();
});

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
  expect(firstBody.messages[0].content).not.toContain("gogo-fpga-changes");
  expect(JSON.parse(firstBody.messages.at(-1).content).skill).toBe("consult");
  expect(JSON.parse(firstBody.messages.at(-1).content).project.board.id).toBe("tangnano1k");
  await expect(page.locator("#ai-preview-target")).toContainText(String(Buffer.byteLength(first)));
  await page.locator("#ai-skill").selectOption("change", { force: true });
  await expect(page.locator("#ai-preview")).toBeHidden();
  await page.locator("#ai-preview-button").click();
  expect(JSON.parse(await page.locator("#ai-preview-body").inputValue()).messages[0].content).toContain("gogo-fpga-changes");
  expect(JSON.parse(firstBody.messages.at(-1).content).files.map((f) => f.path)).toEqual(["src/top.v"]);
  await expect(page.locator("#ai-preview-headers")).toContainText("午後のFPGA");
  expect(requests).toHaveLength(0);
  await page.locator("#ai-preview-cancel").click(); await page.locator("#ai-model").fill("test/model");
  await expect(page.locator("#ai-preview")).toBeHidden();
  await page.locator("#ai-preview-button").click();
  const sent = await page.locator("#ai-preview-body").inputValue();
  await page.locator("#ai-send").click(); await expect(page.locator("#ai-chat-response")).toHaveText("説明です。");
  await expect(page.locator("#ai-usage")).toHaveText("使用量は返されませんでした");
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
  await expect(page.locator("#ai-skill")).toHaveValue("explain");
  expect(await page.locator("#ai-prompt").inputValue()).toContain("原因、根拠、修正の手順");
  await page.locator("#ai-preview-button").click();
  const body = JSON.parse(await page.locator("#ai-preview-body").inputValue()); const context = JSON.parse(body.messages.at(-1).content);
  expect(context.problems.length).toBeGreaterThan(0); expect(context.logs.length).toBeGreaterThan(0); expect(context.files.map((f) => f.path)).toContain("src/top.v");
  await page.locator("#ai-preview-cancel").click();
  await page.locator("#problem-list").getByRole("button", { name: "エラーを AI に説明してもらう", exact: true }).first().click();
  await expect(page.locator("#ai-prompt")).toHaveValue(/原因、根拠、修正の手順/);
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
