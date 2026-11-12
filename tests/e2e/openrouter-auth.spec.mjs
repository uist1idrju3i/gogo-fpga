import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

const pendingKey = "gogo-fpga.openrouter.pkce";
const testKey = "sk-or-test-only";

async function openAi(page) {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await page.locator("#right-tab-ai").click();
  await expect(page.locator("#ai-connect")).toBeEnabled();
  await expectConnectionNotes(page, false);
}

async function expectConnectionNotes(page, connected) {
  for (const id of ["ai-persist-note", "ai-disconnect-note"]) {
    if (connected) await expect(page.locator(`#${id}`)).toBeVisible();
    else await expect(page.locator(`#${id}`)).toBeHidden();
  }
}

async function mockOpenRouter(page, { tamper = false, httpError = false } = {}) {
  let challenge;
  let exchanges = 0;
  await page.route("https://openrouter.ai/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/auth") {
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      challenge = url.searchParams.get("code_challenge");
      const callback = new URL(url.searchParams.get("callback_url"));
      expect(callback.search).toBe("");
      expect(callback.hash).toBe("");
      callback.searchParams.set("code", "test-code");
      callback.searchParams.set("state", tamper ? "tampered-state" : url.searchParams.get("state"));
      await route.fulfill({ status: 302, headers: { location: callback.href } });
      return;
    }
    expect(url.pathname).toBe("/api/v1/auth/keys");
    const headers = { "Access-Control-Allow-Origin": new URL(page.url()).origin,
      "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    exchanges += 1;
    expect(page.url()).not.toMatch(/[?&](code|state)=/);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
    expect(request.method()).toBe("POST");
    const body = request.postDataJSON();
    expect(body.code).toBe("test-code");
    expect(body.code_challenge_method).toBe("S256");
    expect(body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createHash("sha256").update(body.code_verifier).digest("base64url")).toBe(challenge);
    await route.fulfill({ status: httpError ? 403 : 200, headers,
      contentType: "application/json", body: JSON.stringify(httpError ? { error: testKey } : { key: testKey }) });
  });
  return () => exchanges;
}

test("same-tab PKCE flushes edits, scrubs callback, keeps default key only in memory and never logs it", async ({ page, context }) => {
  const messages = [];
  page.on("console", (message) => messages.push(message.text()));
  page.on("pageerror", (error) => messages.push(error.message));
  const count = await mockOpenRouter(page);
  await openAi(page);
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// OAuth save test");
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("接続済み（このタブを閉じるまで）");
  await expect(page.locator("#right-tab-ai")).toHaveAttribute("aria-selected", "true");
  await expectConnectionNotes(page, true);
  await expect(page.locator("#ai-persist")).toHaveAttribute("aria-describedby", "ai-persist-note");
  await expect(page.locator("#ai-disconnect")).toHaveAttribute("aria-describedby", "ai-disconnect-note");
  const button = await page.locator("#ai-disconnect").boundingBox();
  const note = await page.locator("#ai-disconnect-note").boundingBox();
  expect(note.y - (button.y + button.height)).toBeGreaterThanOrEqual(12);
  expect(count()).toBe(1);
  expect(context.pages()).toHaveLength(1);
  expect(page.url()).not.toContain(testKey);
  expect(page.url()).not.toMatch(/[?&](code|state)=/);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
  expect(await page.locator(".cm-content").innerText()).toContain("OAuth save test");
  expect(await page.evaluate(() => Object.values(localStorage).join(" "))).not.toContain(testKey);
  expect(await page.evaluate(() => Object.values(sessionStorage).join(" "))).not.toContain(testKey);
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name))).not.toContain("gogo-fpga-ai");
  expect(messages.join("\n")).not.toContain(testKey);
  await page.reload();
  await page.locator("#right-tab-ai").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("未接続です。");
  await expectConnectionNotes(page, false);
});

test("IndexedDB is explicitly opt-in, restores after reload and is erased when unchecked or disconnected", async ({ page }) => {
  await mockOpenRouter(page);
  await openAi(page);
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-persist")).toBeEnabled();
  await page.locator("#ai-persist").check();
  await expect(page.locator("#ai-auth-status")).toHaveText("接続済み（このブラウザーに保存済み）");
  await page.reload();
  await page.locator("#right-tab-ai").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("接続済み（このブラウザーに保存済み）");
  await page.locator("#ai-persist").uncheck();
  await expect(page.locator("#ai-auth-status")).toHaveText("接続済み（このタブを閉じるまで）");
  await page.reload();
  await page.locator("#right-tab-ai").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("未接続です。");
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-persist")).toBeEnabled();
  await page.locator("#ai-persist").check();
  await expect(page.locator("#ai-auth-status")).toContainText("保存済み");
  await page.evaluate(() => {
    window.originalCredentialDelete = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = () => { throw new Error("Delete unavailable"); };
  });
  await page.locator("#ai-disconnect").click();
  await expect(page.locator("#ai-auth-error")).toContainText("保存・削除できません");
  await expect(page.locator("#ai-auth-status")).toHaveText("未接続です。");
  await expectConnectionNotes(page, false);
  await page.evaluate(() => { IDBObjectStore.prototype.delete = window.originalCredentialDelete; });
  await page.locator("#ai-disconnect").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("未接続です。");
  await expectConnectionNotes(page, false);
  await page.reload();
  await page.locator("#right-tab-ai").click();
  await expect(page.locator("#ai-auth-status")).toHaveText("未接続です。");
});

test("tampered state is rejected without exchange and pending data is removed", async ({ page }) => {
  const count = await mockOpenRouter(page, { tamper: true });
  await openAi(page);
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-auth-error")).toContainText("確認情報が一致しません");
  await expectConnectionNotes(page, false);
  expect(count()).toBe(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
  expect(page.url()).not.toMatch(/[?&](code|state)=/);
  await expect(page.locator("#ai-connect")).toBeEnabled();
});

test("failed exchange displays only sanitized Japanese text and clears pending", async ({ page }) => {
  await mockOpenRouter(page, { httpError: true });
  await openAi(page);
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-auth-error")).toContainText("接続を受け付けませんでした");
  await expectConnectionNotes(page, false);
  expect(await page.locator("#right-panel-ai").innerText()).not.toContain(testKey);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
});

test("CSP is delivered and blocks third-party requests before they leave the browser", async ({ page }) => {
  const response = await page.goto("/");
  expect(response.headers()["content-security-policy"]).toBe("connect-src 'self' https://openrouter.ai; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'self'");
  let requests = 0;
  await page.route("https://example.com/**", async (route) => { requests += 1; await route.abort(); });
  const blocked = await page.evaluate(async () => {
    try { await fetch("https://example.com/forbidden"); return false; } catch { return true; }
  });
  expect(blocked).toBe(true);
  expect(requests).toBe(0);
});

test("save failure prevents OAuth navigation and preserves the editor", async ({ page }) => {
  let authRequests = 0;
  page.on("request", (request) => { if (request.url().startsWith("https://openrouter.ai/")) authRequests += 1; });
  await openAi(page);
  await page.evaluate(() => {
    FileSystemFileHandle.prototype.createWritable = async () => { throw new Error("Save unavailable"); };
  });
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("\n// Unsaved edit");
  await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-auth-error")).toContainText("保存できないため移動しません");
  await expect(page.locator(".cm-content")).toContainText("Unsaved edit");
  expect(authRequests).toBe(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
});

for (const variant of ["expired", "denied"]) {
  test(`${variant} callback clears pending and never exchanges a code`, async ({ page }) => {
    const count = await mockOpenRouter(page);
    await page.addInitScript(({ key, variant }) => {
      sessionStorage.setItem(key, JSON.stringify({ verifier: "v".repeat(43), state: "s".repeat(43),
        createdAt: Date.now() - (variant === "expired" ? 600001 : 0) }));
    }, { key: pendingKey, variant });
    await page.goto(variant === "expired" ? `/?code=test-code&state=${"s".repeat(43)}` : "/?error=access_denied");
    await expect(page.locator("#ai-auth-error")).toContainText(variant === "expired" ? "有効時間" : "接続は完了しませんでした");
    expect(count()).toBe(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), pendingKey)).toBeNull();
    expect(page.url()).not.toMatch(/[?&](code|state|error)=/);
  });
}

test("CSP permits real built-in SAT formal success and counterexamples", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  for (const [source, expected] of [
    ["module top(input wire a); always @* begin assume(a); assert(a); end endmodule", "境界付きで安全を確認"],
    ["module top(input wire a); always @* assert(a); endmodule", "反例が見つかりました"],
  ]) {
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(source);
    await page.locator("#right-tab-verify").click();
    await page.locator("#formal-engine").selectOption("yosys-sat");
    await page.locator("#formal-depth").fill("3");
    await page.locator("#formal-button").click();
    await expect(page.locator("#formal-status")).toContainText(expected, { timeout: 120_000 });
    await expect(page.locator("#formal-button")).toBeEnabled();
  }
});
