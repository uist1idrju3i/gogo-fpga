import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BOARDS } from "../../web/lib/boards.mjs";
import { fsIdcode, fsIdcodeMatchesBoard } from "../../web/lib/fs-idcode.mjs";
import { routeWorkerWithFakeUsb, stubPageUsb } from "./fake-usb-helpers.mjs";
import { storedFile } from "./project-storage-helpers.mjs";

// Validates that each board template builds a .fs with the right IDCODE and
// that the fake-USB flash path completes, both locally and on the deployed site.

// The fake-USB route replaces the flasher worker with the repository copy, so a
// stale or broken worker.js on the server would go unnoticed: compare the
// served bytes against web/worker.js first.
test("served flasher worker matches the repository worker", async ({
  request,
}) => {
  const response = await request.get("/worker.js");
  expect(response.ok()).toBe(true);
  expect(Buffer.from(await response.body())).toEqual(
    readFileSync(resolve(import.meta.dirname, "../../web/worker.js")),
  );
});

async function deleteProject(page, name) {
  await page.evaluate(async (projectName) => {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle("projects");
    try {
      await projects.removeEntry(projectName, { recursive: true });
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  }, name);
}

for (const board of BOARDS) {
  for (const language of ["verilog", "vhdl"]) {
    test(`build+flash ${board.id} ${language}`, async ({ page }) => {
      test.setTimeout(300_000);
      await stubPageUsb(page);
      await routeWorkerWithFakeUsb(page, { idcode: board.idcode });
      await page.goto("/");
      await expect(page.locator("#project-status")).toHaveText("保存しました。");
      const name = `e2e-${board.id}-${language}-${randomUUID().slice(0, 8)}`;
      try {
        await page.locator("#new-project-button").click();
        await page.locator("#new-project-name").fill(name);
        await page.locator("#new-project-board").selectOption(board.id);
        await page.locator("#new-project-language").selectOption(language);
        await page.locator("#new-project-create").click();
        await expect(page.locator("#project-name")).toHaveText(name);
        await expect(page.locator("#synthesis-button")).toBeEnabled();
        await page.locator("#synthesis-button").click();
        await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
          timeout: 200_000,
        });
        const fsBytes = await storedFile(page, name, "build/top.fs");
        const idcode = fsIdcode(fsBytes.toString("utf8"));
        expect(
          fsIdcodeMatchesBoard(idcode, board),
          `.fs IDCODE 0x${idcode.toString(16)} must match ${board.id}`,
        ).toBe(true);
        await expect(page.locator("#program-button")).toBeEnabled();
        await page.locator("#program-button").click();
        await expect(page.locator("#result-status")).toHaveText("成功", {
          timeout: 60_000,
        });
      } finally {
        await deleteProject(page, name);
      }
    });
  }
}
