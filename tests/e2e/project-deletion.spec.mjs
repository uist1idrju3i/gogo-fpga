import { expect, test } from "@playwright/test";
import { BOARDS } from "../../web/lib/boards.mjs";

async function openIde(page) {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
}

async function createProject(page, name) {
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(name);
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
}

async function storedProjects(page) {
  return page.evaluate(async () => {
    const { createOpfsStore } = await import("/lib/project-store.mjs");
    return createOpfsStore(navigator.storage).listProjects();
  });
}

async function confirmDeletion(page) {
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#delete-project-button").click();
}

async function expectProjectDirectoryAbsent(page, name) {
  const absent = await page.evaluate(async (projectName) => {
    const root = await navigator.storage.getDirectory();
    const projects = await root.getDirectoryHandle("projects");
    try {
      await projects.getDirectoryHandle(projectName);
      return false;
    } catch (error) {
      if (error.name === "NotFoundError") return true;
      throw error;
    }
  }, name);
  expect(absent, `OPFS directory ${name} must be absent`).toBe(true);
}

test("project deletion can be cancelled and removes only the confirmed project", async ({ page }) => {
  await openIde(page);
  await createProject(page, "zz-delete");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#delete-project-button").click();
  await expect(page.locator("#project-name")).toHaveText("zz-delete");
  expect(await storedProjects(page)).toEqual(["blink", "zz-delete"]);
  await confirmDeletion(page);
  await expect(page.locator("#project-action-status")).toHaveText("「zz-delete」を削除しました。");
  await expect(page.locator("#project-name")).toHaveText("blink");
  expect(await storedProjects(page)).toEqual(["blink"]);
  await expectProjectDirectoryAbsent(page, "zz-delete");
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("blink");
  await expect(page.locator("#project-select option")).toHaveCount(1);
});

test("deleting the last project stays empty after reload and permits creating a new project", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openIde(page);
  await confirmDeletion(page);
  await expect(page.locator("#project-name")).toHaveText("なし");
  await expect(page.locator("#delete-project-button")).toBeDisabled();
  await expect(page.locator("#synthesis-button")).toBeDisabled();
  await expect(page.locator("#add-file-button")).toBeDisabled();
  await expect(page.locator("#file-list")).toBeEmpty();
  expect(await storedProjects(page)).toEqual([]);
  await expectProjectDirectoryAbsent(page, "blink");
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("なし");
  await expect(page.locator("#project-select option")).toHaveCount(0);
  await createProject(page, "fresh");
  await expect(page.locator("#delete-project-button")).toBeEnabled();
  expect(await storedProjects(page)).toEqual(["fresh"]);
  expect(errors).toEqual([]);
});

test("failed OPFS deletion keeps the project editable and reports the failure", async ({ page }) => {
  await openIde(page);
  await page.evaluate(() => {
    const remove = FileSystemDirectoryHandle.prototype.removeEntry;
    FileSystemDirectoryHandle.prototype.removeEntry = function (name, options) {
      if (this.name === "projects" && name === "blink") {
        return Promise.reject(new DOMException("Injected deletion failure", "NotAllowedError"));
      }
      return remove.call(this, name, options);
    };
  });
  await page.locator(".cm-content").press("Control+End");
  await page.keyboard.insertText("\n// 削除失敗後にも残る編集\n");
  const edited = await page.locator(".cm-content").textContent();
  await confirmDeletion(page);
  await expect(page.locator("#project-action-status")).toContainText("プロジェクトを削除できません");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await expect(page.locator("#delete-project-button")).toBeEnabled();
  await expect(page.locator(".cm-content")).toHaveAttribute("contenteditable", "true");
  expect(await page.locator(".cm-content").textContent()).toBe(edited);
  expect(await storedProjects(page)).toEqual(["blink"]);
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  await page.reload();
  await expect(page.locator(".cm-content")).toContainText("削除失敗後にも残る編集");
});

test("deletion drains manual saves and prevents a late save from recreating the project", async ({ page }) => {
  await openIde(page);
  await createProject(page, "zz-pending");
  await page.evaluate(() => {
    const close = FileSystemWritableFileStream.prototype.close;
    const released = new Promise((resolve) => { window.releaseProjectSave = resolve; });
    FileSystemWritableFileStream.prototype.close = async function () {
      window.projectSaveStarted = true;
      await released;
      return close.call(this);
    };
  });
  await page.keyboard.press("Control+s");
  await expect.poll(() => page.evaluate(() => window.projectSaveStarted)).toBe(true);
  await confirmDeletion(page);
  await expect(page.locator("#delete-project-button")).toBeDisabled();
  expect(await storedProjects(page)).toContain("zz-pending");
  await page.keyboard.press("Control+s");
  await page.evaluate(() => window.releaseProjectSave());
  await expect(page.locator("#project-action-status")).toHaveText("「zz-pending」を削除しました。");
  expect(await storedProjects(page)).toEqual(["blink"]);
  await expectProjectDirectoryAbsent(page, "zz-pending");
  await page.reload();
  await expect(page.locator("#project-name")).toHaveText("blink");
  expect(await storedProjects(page)).toEqual(["blink"]);
});

test("project deletion controls remain visible on all supported boards", async ({ page }, testInfo) => {
  await openIde(page);
  for (const board of BOARDS) {
    await page.locator("#board-select").selectOption(board.id);
    await expect(page.locator("#project-status")).toHaveText("保存しました。");
    await expect(page.locator("#delete-project-button")).toBeVisible();
    await expect(page.locator("#delete-project-button")).toBeEnabled();
    const screenshot = testInfo.outputPath(`${board.id}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach(board.id, { path: screenshot, contentType: "image/png" });
  }
});
