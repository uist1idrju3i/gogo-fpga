import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { BOARDS } from "../../web/lib/boards.mjs";
import { storedFile, storedFsDigest } from "./project-storage-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const variant = process.env.S5_CHROMIUM_VARIANT;
const selectedAssetDir = process.env.S5_ASSET_DIR;
const repeats = Number(process.env.S5_CHROMIUM_REPEATS ?? "5");
const s5bVariants = process.env.S5_CHROMIUM_VARIANTS?.split(",") ?? [];
const s5bAssetBundleRoot = process.env.S5_ASSET_BUNDLE_ROOT;
const recordIntermediate = process.env.S5_RECORD_INTERMEDIATE === "1";

async function createProject(page, board) {
  await page.goto("/");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  const name = `s5-${board.id}-${randomUUID().slice(0, 8)}`;
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-board").selectOption(board.id);
  await page.locator("#new-project-language").selectOption("verilog");
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(name);
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  return name;
}

async function storedIntermediateDigests(page, projectName) {
  const digest = async (path) => createHash("sha256")
    .update(await storedFile(page, projectName, path)).digest("hex");
  return {
    netlist_sha256: await digest("build/top.json"),
    pnr_sha256: await digest("build/top_pnr.json"),
  };
}

if (s5bVariants.length > 0) {
  assert.deepEqual(s5bVariants, ["B", "B2", "LTO", "Os", "OsLTO"]);
  assert.ok(s5bAssetBundleRoot && selectedAssetDir);
  assert.equal(repeats, 5);
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const board of BOARDS) {
      for (const s5bVariant of s5bVariants) {
        test(
          `S5B Chromium ${s5bVariant} ${board.id} repeat ${repeat}`,
          async ({ page }) => {
            const source = path.resolve(root, s5bAssetBundleRoot, s5bVariant);
            const destination = path.join(root, "dist/synth");
            rmSync(destination, { recursive: true, force: true });
            cpSync(source, destination, { recursive: true });
            const projectName = await createProject(page, board);
            await page.evaluate(() => {
              window.__s5BuildResults = [];
              window.addEventListener("toolchain:build-complete", ({ detail }) => {
                window.__s5BuildResults.push(detail);
              });
            });
            const expectedBytes = readFileSync(
              path.join(root, "build/e2e-expected", `${board.id}.fs`),
            );
            const expectedHash = createHash("sha256")
              .update(expectedBytes)
              .digest("hex");
            await page.locator("#synthesis-button").click();
            await expect(page.locator("#synthesis-button")).toHaveText("中止");
            await expect(page.locator("#program-button")).toBeDisabled();
            await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
              timeout: 140_000,
            });
            await expect(page.locator("#fs-source")).toHaveValue("build/top.fs");
            const actual = await storedFsDigest(page, projectName);
            expect(actual).toEqual({ size: expectedBytes.length, sha256: expectedHash });
            const intermediate = recordIntermediate
              ? await storedIntermediateDigests(page, projectName)
              : {};
            const [measurement] = await page.evaluate(() =>
              window.__s5BuildResults.splice(0, 1),
            );
            expect(measurement).toBeTruthy();
            console.log(
              `S5_BROWSER_METRIC ${JSON.stringify({
                variant: s5bVariant,
                board: board.id,
                repeat,
                synth_ms: measurement.timings.synth,
                pnr_ms: measurement.timings.pnr,
                fs_size: actual.size,
                fs_sha256: actual.sha256,
                ...intermediate,
              })}`,
            );
          },
        );
      }
    }
  }
} else {
  for (const board of BOARDS) {
    test(`S5 Chromium build matches the baseline for ${board.id}`, async ({ page }) => {
      test.skip(
        !variant || !selectedAssetDir,
        "Set S5_CHROMIUM_VARIANT and S5_ASSET_DIR to run the S5 finalist measurement.",
      );
      assert.ok(Number.isInteger(repeats) && repeats > 0);
      const projectName = await createProject(page, board);
      await page.evaluate(() => {
        window.__s5BuildResults = [];
        window.addEventListener("toolchain:build-complete", ({ detail }) => {
          window.__s5BuildResults.push(detail);
        });
      });
      const expectedBytes = readFileSync(
        path.join(root, "build/e2e-expected", `${board.id}.fs`),
      );
      const expectedHash = createHash("sha256").update(expectedBytes).digest("hex");
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        if (repeat > 1) await expect(page.locator("#program-button")).toBeEnabled();
        await page.locator("#synthesis-button").click();
        await expect(page.locator("#synthesis-button")).toHaveText("中止");
        await expect(page.locator("#program-button")).toBeDisabled();
        await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
          timeout: 140_000,
        });
        await expect(page.locator("#fs-source")).toHaveValue("build/top.fs");
        const actual = await storedFsDigest(page, projectName);
        expect(actual).toEqual({ size: expectedBytes.length, sha256: expectedHash });
        const intermediate = recordIntermediate
          ? await storedIntermediateDigests(page, projectName)
          : {};
        const [measurement] = await page.evaluate(() =>
          window.__s5BuildResults.splice(0, 1),
        );
        expect(measurement).toBeTruthy();
        console.log(
          `S5_BROWSER_METRIC ${JSON.stringify({
            variant,
            board: board.id,
            repeat,
            synth_ms: measurement.timings.synth,
            pnr_ms: measurement.timings.pnr,
            fs_size: actual.size,
            fs_sha256: actual.sha256,
            ...intermediate,
          })}`,
        );
      }
    });
  }
}
