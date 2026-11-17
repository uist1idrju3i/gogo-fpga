import { expect, test } from "@playwright/test";

test("reload restores the selected project and deletion falls back", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill("zz-last-project");
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText("zz-last-project");
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("zz-last-project");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#delete-project-button").click();
  await expect(page.locator("#project-name")).toHaveText("blink");
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("blink");
  await page.evaluate(() => localStorage.setItem("toolchain.ide.last-project", "deleted-elsewhere"));
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("blink");
});
