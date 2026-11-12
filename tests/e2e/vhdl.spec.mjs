import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";
import { storedFile } from "./project-storage-helpers.mjs";

const root = resolve(import.meta.dirname, "../..");
const screenshots = resolve(root, "build/T3-2/screenshots");
const fixtureRoot = resolve(root, "tests/fixtures/vhdl");
const expectedRoot = resolve(root, "build/e2e-expected");
mkdirSync(screenshots, { recursive: true });

function fixture(name) {
  return readFileSync(resolve(fixtureRoot, name), "utf8");
}

async function createProject(page, board, language = "vhdl", standard = "2008") {
  await page.goto("/");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  const name = `t3-2-${board.id}-${language}-${randomUUID().slice(0, 8)}`;
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-board").selectOption(board.id);
  await page.locator("#new-project-language").selectOption(language);
  if (language === "vhdl") {
    await expect(page.locator("#new-project-standard-field")).toBeVisible();
    await page.locator("#new-project-standard").selectOption(standard);
  }
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(name);
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  return name;
}

async function replaceEditor(page, content) {
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(content);
  await expect(page.locator("#project-status")).toHaveText("保存しました。", {
    timeout: 10_000,
  });
}

async function addSourceFile(page, path, content) {
  await page.locator("#add-file-button").click();
  await page.locator("#file-path-input").fill(path);
  await page.locator("#file-path-save").click();
  await expect(page.locator(".cm-content")).toBeVisible();
  await replaceEditor(page, content);
}

async function buildProject(page) {
  await page.locator("#synthesis-button").click();
  const stage = page.locator("#synthesis-stage");
  await expect(stage).toHaveText(/^(ビルド完了|ビルド失敗)$/, {
    timeout: 150_000,
  });
  const result = await stage.innerText();
  if (result !== "ビルド完了") {
    await page.locator("#bottom-tab-log").click();
    throw new Error(`Browser synthesis failed:\n${await page.locator("#program-log").innerText()}`);
  }
}

async function assertFsMatches(page, projectName, expectedName) {
  const actual = await storedFile(page, projectName, "build/top.fs");
  const expected = readFileSync(resolve(expectedRoot, expectedName));
  assert.deepEqual(Buffer.from(actual), expected, `${expectedName} differs from native .fs`);
}

async function readTopJson(page, projectName) {
  const bytes = await storedFile(page, projectName, "build/top.json");
  return JSON.parse(new TextDecoder().decode(bytes));
}

for (const board of BOARDS) {
  test(`VHDL template builds the native-identical .fs for ${board.id}`, async ({
    page,
  }) => {
    const projectName = await createProject(page, board);
    await expect(page.locator("#vhdl-standard")).toHaveValue("2008");
    await buildProject(page);
    await assertFsMatches(page, projectName, `${board.id}-vhdl.fs`);
    await page.screenshot({
      path: resolve(screenshots, `${board.id}-vhdl-success-desktop.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: resolve(screenshots, `${board.id}-vhdl-success-390.png`),
      fullPage: true,
    });
  });
}

test("VHDL-2019 named return builds with the selected standard", async ({ page }) => {
  const projectName = await createProject(page, BOARDS[0]);
  await page.locator("#vhdl-standard").selectOption("2019");
  await replaceEditor(page, fixture("return_identifier_top.vhd"));
  await expect(page.locator("#vhdl-standard")).toHaveValue("2019");
  await page.screenshot({
    path: resolve(screenshots, "vhdl-2019-selector-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(screenshots, "vhdl-2019-selector-390.png"),
    fullPage: true,
  });
  await buildProject(page);
  expect((await storedFile(page, projectName, "build/top.fs")).byteLength).toBeGreaterThan(0);
});

test("Verilog top instantiates a synthesized VHDL child", async ({ page }) => {
  const board = BOARDS[0];
  const projectName = await createProject(page, board, "verilog");
  await replaceEditor(page, fixture("mixed-verilog-top.v"));
  await addSourceFile(page, "src/child.vhd", fixture("mixed-vhdl-child.vhd"));
  await buildProject(page);
  await assertFsMatches(page, projectName, "mixed-verilog-top.fs");
});

test("VHDL top instantiates a Verilog blackbox", async ({ page }) => {
  const board = BOARDS[0];
  const projectName = await createProject(page, board);
  await replaceEditor(page, fixture("mixed-vhdl-top.vhd"));
  await addSourceFile(page, "src/child.v", fixture("mixed-verilog-child.v"));
  await buildProject(page);
  await assertFsMatches(page, projectName, "mixed-vhdl-top.fs");
});

test("VHDL keep attribute reaches Yosys netnames and is absent without it", async ({
  page,
}) => {
  const projectName = await createProject(page, BOARDS[0]);
  await replaceEditor(page, fixture("keep-top.vhd"));
  await buildProject(page);
  const kept = await readTopJson(page, projectName);
  const keptNet = Object.values(kept.modules.top.netnames).find(({ attributes }) =>
    Object.hasOwn(attributes ?? {}, "keep")
  );
  expect(keptNet).toBeTruthy();

  await replaceEditor(page, fixture("keep-top-no-attribute.vhd"));
  await buildProject(page);
  const unkept = await readTopJson(page, projectName);
  expect(
    Object.values(unkept.modules.top.netnames).some(({ attributes }) =>
      Object.hasOwn(attributes ?? {}, "keep")
    ),
  ).toBe(false);
});

test("VHDL syntax and semantic diagnostics identify project lines", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  await replaceEditor(page, [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "entity top is port (clk : in std_logic; led : out std_logic); end entity;",
    "architecture rtl of top is begin",
    "  led <= ;",
    "end architecture;",
  ].join("\n"));
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 60_000,
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("src/top.vhd:5");
  await expect(page.locator("#problem-list")).toContainText("error");

  await replaceEditor(page, [
    "library ieee;",
    "use ieee.std_logic_1164.all;",
    "entity top is port (clk : in std_logic; led : out std_logic); end entity;",
    "architecture rtl of top is begin",
    "  led <= missing_signal;",
    "end architecture;",
  ].join("\n"));
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 60_000,
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("src/top.vhd:5");
  await expect(page.locator("#problem-list")).toContainText("missing_signal");
  await page.screenshot({
    path: resolve(screenshots, "vhdl-error-diagnostics-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: resolve(screenshots, "vhdl-error-diagnostics-390.png"),
    fullPage: true,
  });
});

test("VHDL source ordering errors identify the project file and line", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  await replaceEditor(page, [
    "library ieee;",
    "use work.missing.all;",
    "entity top is end entity;",
    "architecture rtl of top is begin end architecture;",
  ].join("\n"));
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 30_000,
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("src/top.vhd:2");
  await expect(page.locator("#problem-list")).toContainText("missing");
});

test("missing GHDL runtime asset is reported before synthesis", async ({ page }) => {
  await createProject(page, BOARDS[0]);
  await page.route("**/synth/manifest.json", async (route) => {
    const response = await route.fetch();
    const manifest = await response.json();
    manifest.assets = manifest.assets.filter(({ path }) => path !== "ghdl-synth.wasm");
    await route.fulfill({ response, json: manifest });
  });
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 30_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "Synthesis asset is missing from manifest: ghdl-synth.wasm",
  );
});

test("corrupted GHDL runtime asset fails its compressed digest check", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  const compressed = Buffer.from(
    readFileSync(resolve(root, "dist/synth/ghdl-synth.wasm.zst")),
  );
  compressed[Math.floor(compressed.byteLength / 2)] ^= 1;
  await page.route("**/synth/ghdl-synth.wasm.zst", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: compressed,
    }),
  );
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 30_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "Synthesis asset compressed SHA-256 mismatch for ghdl-synth.wasm",
  );
});

test("corrupted cached GHDL runtime asset is discarded and refetched", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  const manifest = JSON.parse(
    readFileSync(resolve(root, "dist/synth/manifest.json"), "utf8"),
  );
  const asset = manifest.assets.find(({ path }) => path === "ghdl-synth.wasm");
  await page.evaluate(async (sha256) => {
    const cache = await caches.open("gogo-fpga-synth-v1");
    const key = new URL(`synth/ghdl-synth.wasm?sha256=${sha256}`, location.href);
    await cache.put(
      key,
      new Response("corrupt cached GHDL", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }, asset.sha256);
  let compressedRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/synth/ghdl-synth.wasm.zst") compressedRequests += 1;
  });
  await buildProject(page);
  expect(compressedRequests).toBe(1);
});
