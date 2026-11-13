import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const info = { sha: "8ce027b48a278026d4ba36d61013469b58ae195d", short_sha: "8ce027b",
  run_url: "https://github.com/uist1idrju3i/gogo-fpga/actions/runs/43332364067",
  commit_date: "2026-11-12T12:00:00Z" };
const shots = resolve("build/screenshots/publication-info");

test("published source and DeepWiki are accessible without external resource requests", async ({ page }) => {
  const external = [];
  page.on("request", request => {
    if (new URL(request.url()).origin !== new URL(test.info().project.use.baseURL).origin) {
      external.push(request.url());
    }
  });
  await page.route("**/build-info.json", route => route.fulfill({ json: info }));
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  const version = page.getByRole("link", { name: "公開版 8ce027b" });
  await expect(version).toHaveAttribute("href", `https://github.com/uist1idrju3i/gogo-fpga/commit/${info.sha}`);
  await expect(version).toHaveAttribute("title", new RegExp(info.sha));
  const wiki = page.getByRole("link", { name: "仕組みを読む · DeepWiki" });
  await expect(wiki).toHaveAttribute("href", "https://deepwiki.com/uist1idrju3i/gogo-fpga");
  await expect(wiki).toHaveAttribute("target", "_blank");
  await expect(wiki).toHaveAttribute("rel", "noopener noreferrer");
  mkdirSync(shots, { recursive: true });
  for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
    await page.setViewportSize({ width: 1280, height: 960 });
    await page.locator("#board-select").selectOption(board);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await page.screenshot({ path: resolve(shots, `${board}-1280.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(version).toBeVisible();
  await expect(wiki).toBeVisible();
  const row = await page.locator(".publication-information").boundingBox();
  expect(row.x).toBeGreaterThanOrEqual(0);
  expect(row.x + row.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: resolve(shots, "publication-390.png") });
  expect(external).toEqual([]);
});

for (const failure of ["absent", "invalid", "offline", "redirect", "development"]) {
  test(`metadata ${failure} leaves editing available in development mode`, async ({ page }) => {
    await page.route("**/build-info.json", route => {
      if (failure === "offline") return route.abort();
      if (failure === "absent") return route.fulfill({ status: 404, body: "missing" });
      if (failure === "invalid") return route.fulfill({ json: { ...info, sha: "not-a-sha" } });
      if (failure === "redirect") return route.fulfill({ status: 302,
        headers: { location: "https://example.invalid/build-info.json" } });
      return route.fulfill({ body: "null", contentType: "application/json" });
    });
    const errors = [];
    const external = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.url().startsWith("https://example.invalid")) external.push(request.url());
    });
    await page.goto("/");
    await expect(page.locator("#publication-version")).toHaveText("開発版");
    await expect(page.locator("#project-name")).toHaveText("blink");
    await expect(page.locator("#synthesis-button")).toBeEnabled();
    await page.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("\n// development");
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
}
