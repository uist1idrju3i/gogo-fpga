import { expect, test } from "@playwright/test";
import { homedir } from "node:os";
import { resolve } from "node:path";

async function prepare(page, availability = "available") {
  await page.addInitScript(({ availability }) => {
    localStorage.setItem("gogo-fpga.welcome.dismissed", "true");
    window.completionTest = { creates: 0, prompts: [], aborted: 0, destroyed: 0, delay: 10 };
    if (availability === "absent") { delete globalThis.LanguageModel; return; }
    globalThis.LanguageModel = {
      async availability() { return availability; },
      async create(options) {
        completionTest.creates++;
        options.monitor({ addEventListener(name, listener) { listener({ loaded: 0.5 }); } });
        await new Promise(resolve => setTimeout(resolve, 150));
        return {
          contextUsage: 0, inputQuota: 4096,
          destroy() { completionTest.destroyed++; },
          async clone() {
            return {
              destroy() { completionTest.destroyed++; },
              promptStreaming(prompt, { signal }) {
                completionTest.prompts.push(prompt);
                return new ReadableStream({ start(controller) {
                  const timer = setTimeout(() => { controller.enqueue("// <img src=x> local suggestion\n"); controller.close(); }, completionTest.delay);
                  signal.addEventListener("abort", () => { completionTest.aborted++; clearTimeout(timer); controller.error(new DOMException("abort", "AbortError")); }, { once: true });
                } });
              },
            };
          },
        };
      },
    };
  }, { availability });
  await page.goto("/"); await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.locator("#right-tab-ai").click();
}

for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
  test(`on-device ghost completion and undo on ${board}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1600, height: 1500 });
    const unexpected = [];
    page.on("request", request => { if (new URL(request.url()).origin !== new URL(baseURL).origin && !request.url().startsWith("blob:")) unexpected.push(request.url()); });
    await prepare(page, "downloadable");
    await page.locator("#new-project-button").click(); await page.locator("#new-project-name").fill(`completion-${board}`);
    await page.locator("#new-project-board").selectOption(board); await page.locator("#new-project-create").click();
    await expect(page.locator("#project-status")).toHaveText("保存しました。"); await page.locator("#right-tab-ai").click();
    await expect(page.locator("#ai-completion-status")).toHaveAttribute("data-availability", "downloadable");
    expect(await page.evaluate(() => completionTest.creates)).toBe(0);
    await page.locator("#ai-completion-enable").click();
    await expect(page.locator("#ai-completion-status")).toContainText("50%");
    await expect(page.locator("#ai-completion-enable")).toHaveAttribute("aria-pressed", "true");
    const editor = page.locator(".cm-content"); await editor.click(); await editor.press("Control+Home");
    await editor.pressSequentially("// typed\n");
    await expect(page.locator(".cm-local-completion")).toHaveText("// <img src=x> local suggestion\n");
    await expect(page.locator(".cm-local-completion img")).toHaveCount(0);
    await page.screenshot({ path: resolve(homedir(), "shots", `ai-complete-${board}.png`) });
    await editor.press("Tab"); await expect(page.locator(".cm-local-completion")).toHaveCount(0);
    expect(await editor.innerText()).toContain("// <img src=x> local suggestion");
    await editor.press("Control+z"); await expect(editor).not.toContainText("// <img src=x> local suggestion");
    await expect(editor).toContainText("// typed");
    await editor.press("Alt+Backslash"); await expect(page.locator(".cm-local-completion")).toHaveCount(1);
    await editor.press("Escape"); await expect(page.locator(".cm-local-completion")).toHaveCount(0);
    const prompt = await page.evaluate(() => completionTest.prompts[0]);
    const context = JSON.parse(prompt.split("\n").at(-1));
    expect(context.path).toBe("src/top.v"); expect(Object.keys(context).sort()).toEqual(["language", "path", "prefix", "suffix"]);
    expect(new TextEncoder().encode(context.prefix).length).toBeLessThanOrEqual(2048);
    expect(new TextEncoder().encode(context.suffix).length).toBeLessThanOrEqual(1024);
    expect(unexpected).toEqual([]);
  });
}

test("edits, cursor moves and file switches abort pending completion", async ({ page }) => {
  await prepare(page); await page.locator("#ai-completion-enable").click();
  await expect(page.locator("#ai-completion-enable")).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => { completionTest.delay = 60000; });
  const editor = page.locator(".cm-content"); await editor.click(); await editor.press("Control+Home");
  for (const action of ["edit", "cursor", "file"]) {
    const count = await page.evaluate(() => completionTest.prompts.length);
    await editor.press("Alt+Backslash"); await expect.poll(() => page.evaluate(() => completionTest.prompts.length)).toBe(count + 1);
    if (action === "edit") await editor.pressSequentially("// edit\n");
    if (action === "cursor") await editor.press("ArrowRight");
    if (action === "file") await page.locator('#file-list button').filter({ hasText: "src/top_tb.v" }).click();
    await expect.poll(() => page.evaluate(() => completionTest.aborted)).toBeGreaterThanOrEqual(count + 1);
    await expect(page.locator(".cm-local-completion")).toHaveCount(0);
  }
  await page.locator("#ai-completion-enable").click();
  await expect(page.locator("#ai-completion-enable")).toHaveAttribute("aria-pressed", "false");
});

test("Tab without a ghost retains the editor's existing behavior", async ({ page }) => {
  await prepare(page); const editor = page.locator(".cm-content");
  await editor.click(); await editor.press("Control+Home"); const before = await editor.innerText();
  await editor.press("Tab"); const disabledText = await editor.innerText();
  const disabledFocus = await editor.evaluate(node => node === document.activeElement);
  await page.locator("#ai-completion-enable").click(); await expect(page.locator("#ai-completion-enable")).toHaveAttribute("aria-pressed", "true");
  await editor.click(); await editor.press("Control+Home"); await editor.press("Tab");
  expect(await editor.innerText()).toBe(disabledText); expect(disabledText).toBe(before);
  expect(await editor.evaluate(node => node === document.activeElement)).toBe(disabledFocus);
});

for (const availability of ["absent", "unavailable", "downloading", "available"]) {
  test(`local completion availability: ${availability}`, async ({ page }) => {
    await prepare(page, availability);
    await expect(page.locator("#ai-completion-status")).toHaveAttribute("data-availability", availability === "absent" ? "unavailable" : availability);
    if (["absent", "unavailable"].includes(availability)) {
      await expect(page.locator("#ai-completion-enable")).toBeDisabled();
      await expect(page.locator("#ai-completion-status")).toContainText("Android");
    } else await expect(page.locator("#ai-completion-enable")).toBeEnabled();
    expect(await page.evaluate(() => completionTest.creates)).toBe(0);
  });
}
