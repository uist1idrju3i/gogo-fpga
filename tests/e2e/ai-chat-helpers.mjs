import { expect } from "@playwright/test";

export const CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const chatEvent = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\r\n\r\n`;
export const proposalReply = (changes) => `変更理由を確認してください。\n\`\`\`gogo-fpga-changes\n${JSON.stringify({ changes })}\n\`\`\``;

export async function prepareChat(page, { reply = "説明です。", status = 200 } = {}) {
  const requests = [];
  await page.addInitScript(() => localStorage.setItem("gogo-fpga.welcome.dismissed", "true"));
  await page.route("https://openrouter.ai/**", async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/auth") {
      const callback = new URL(url.searchParams.get("callback_url"));
      callback.searchParams.set("code", "chat-test-code"); callback.searchParams.set("state", url.searchParams.get("state"));
      await route.fulfill({ status: 302, headers: { location: callback.href } }); return;
    }
    const headers = { "Access-Control-Allow-Origin": new URL(page.url()).origin,
      "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type,Authorization,HTTP-Referer,X-OpenRouter-Title" };
    if (request.method() === "OPTIONS") { await route.fulfill({ status: 204, headers }); return; }
    if (url.pathname === "/api/v1/auth/keys") {
      await route.fulfill({ status: 200, headers, contentType: "application/json", body: '{"key":"sk-or-chat-test-only"}' }); return;
    }
    expect(request.url()).toBe(CHAT_ENDPOINT); requests.push(request);
    await route.fulfill({ status, headers, contentType: "text/event-stream", body: `${chatEvent(reply)}data: [DONE]\r\n\r\n` });
  });
  await page.goto("/"); await expect(page.locator("#project-status")).toHaveText("保存しました。");
  if ((page.viewportSize()?.width ?? 1280) <= 640) await page.locator("#toggle-board-pane").click();
  await page.locator("#right-tab-ai").click(); await page.locator("#ai-connect").click();
  await expect(page.locator("#ai-auth-status")).toContainText("接続済み");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  return requests;
}

export async function previewAndSend(page, prompt = "この設計を説明してください。") {
  await page.locator("#ai-prompt").fill(prompt); await page.locator("#ai-preview-button").click();
  const body = await page.locator("#ai-preview-body").inputValue();
  await page.locator("#ai-send").click();
  await expect(page.locator("#ai-chat")).toHaveAttribute("data-state", "proposal_review");
  return body;
}

export async function slowChat(page) {
  await page.addInitScript((endpoint) => {
    const original = window.fetch;
    window.fetch = async (input, options) => {
      const response = await original(input, options);
      if (String(input) !== endpoint || !response.ok) return response;
      const bytes = new Uint8Array(await response.arrayBuffer());
      const marker = new TextEncoder().encode("data: [DONE]");
      let split = bytes.length;
      for (let i = 0; i < bytes.length; i++) if (marker.every((b, j) => bytes[i + j] === b)) { split = i; break; }
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, split));
        const timer = setTimeout(() => { controller.enqueue(bytes.slice(split)); controller.close(); }, 3000);
        options.signal.addEventListener("abort", () => { clearTimeout(timer); controller.error(new DOMException("Aborted", "AbortError")); }, { once: true });
      } }), { headers: response.headers });
    };
  }, CHAT_ENDPOINT);
}

export async function projectFile(page, path = "src/top.v") {
  return page.evaluate(async (path) => {
    const { createOpfsStore } = await import("/lib/project-store.mjs");
    const { files } = await createOpfsStore(navigator.storage).load(document.querySelector("#project-name").textContent);
    const content = files.get(path); return typeof content === "string" ? content : content === undefined ? null : new TextDecoder().decode(content);
  }, path);
}
