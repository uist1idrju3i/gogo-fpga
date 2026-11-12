import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOARDS } from "../../web/lib/boards.mjs";
import { fsIdcode, fsIdcodeMatchesBoard } from "../../web/lib/fs-idcode.mjs";
import { routeWorkerWithFakeUsb, stubPageUsb } from "./fake-usb-helpers.mjs";
import { storedFsDigest } from "./project-storage-helpers.mjs";

const root = resolve(import.meta.dirname, "../..");
const expectedRoot = resolve(root, "build/e2e-expected");
const screenshots = resolve(root, "build/screenshots/s4");
mkdirSync(screenshots, { recursive: true });

async function createProject(page, board) {
  await page.goto("/");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  const name = `s4-${board.id}-${randomUUID().slice(0, 8)}`;
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-board").selectOption(board.id);
  await page.locator("#new-project-language").selectOption("verilog");
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(name);
  await expect(page.locator("#synthesis-button")).toBeEnabled();
  return name;
}

async function captureNetworkResponses(context) {
  const responses = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await route.fetch();
    const body = await response.body();
    if (
      request.method() === "GET" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      response.status() >= 200 &&
      response.status() < 300
    ) {
      responses.push({ path: url.pathname, bytes: body.byteLength });
    }
    await route.fulfill({ response, body });
  });
  return responses;
}

function summarizeResponses(responses) {
  const fileSizes = new Map();
  for (const { path, bytes } of responses) {
    fileSizes.set(path, (fileSizes.get(path) ?? 0) + bytes);
  }
  const files = [...fileSizes]
    .map(([path, bytes]) => ({ path, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

for (const board of BOARDS) {
  test(`browser build matches native .fs for ${board.id}`, async ({ page }) => {
    const networkResponses = await captureNetworkResponses(page.context());
    await stubPageUsb(page);
    const projectName = await createProject(page, board);
    const initialCacheNames = await page.evaluate(() => caches.keys());
    expect(initialCacheNames).not.toContain("gogo-fpga-synth-v1");
    expect(initialCacheNames).not.toContain("gogo-fpga-pack-v1");
    await page.evaluate(() => {
      window.__s4BuildResults = [];
      window.addEventListener("toolchain:build-complete", ({ detail }) => {
        window.__s4BuildResults.push(detail);
      });
    });
    const expectedBytes = readFileSync(resolve(expectedRoot, `${board.id}.fs`));
    const expectedHash = createHash("sha256").update(expectedBytes).digest("hex");
    const expectedIdcode = fsIdcode(expectedBytes.toString("utf8"));
    assert.ok(fsIdcodeMatchesBoard(expectedIdcode, board));
    let coldBuildResponses;
    for (let repeat = 0; repeat < 5; repeat += 1) {
      if (repeat > 0) await expect(page.locator("#program-button")).toBeEnabled();
      await page.locator("#synthesis-button").click();
      await expect(page.locator("#synthesis-button")).toHaveText("中止");
      await expect(page.locator("#program-button")).toBeDisabled();
      await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
        timeout: 140_000,
      });
      await expect(page.locator("#fs-source")).toHaveValue("build/top.fs");
      const actual = await storedFsDigest(page, projectName);
      expect(actual).toEqual({
        size: expectedBytes.length,
        sha256: expectedHash,
      });
      if (repeat === 0) {
        coldBuildResponses = [...networkResponses];
        await page.locator("#bottom-tab-log").click();
        await page.screenshot({
          path: resolve(screenshots, `${board.id}-success-log.png`),
        });
        await page.locator("#bottom-tab-artifacts").click();
        await page.screenshot({
          path: resolve(screenshots, `${board.id}-success-artifacts.png`),
        });
      }
      const [measurement] = await page.evaluate(() =>
        window.__s4BuildResults.splice(0, 1),
      );
      expect(measurement).toBeTruthy();
      console.log(
        `S4_BROWSER_METRIC ${JSON.stringify({
          board: board.id,
          repeat: repeat + 1,
          ...measurement,
        })}`,
      );
    }
    let writeWorkerRequests = 0;
    await routeWorkerWithFakeUsb(page, {
      idcode: board.idcode,
      onWorkerRequest: () => {
        writeWorkerRequests += 1;
      },
    });
    await expect(page.locator("#program-button")).toBeEnabled();
    const flashRequestStart = networkResponses.length;
    await page.locator("#program-button").click();
    await expect(page.locator("#result-status")).toHaveText("成功", {
      timeout: 30_000,
    });
    await expect(page.locator("#program-log")).toContainText("Load SRAM");
    expect(writeWorkerRequests).toBe(1);
    const coldLoad = summarizeResponses([
      ...(coldBuildResponses ?? []),
      ...networkResponses.slice(flashRequestStart),
    ]);
    const coldLoadPaths = new Set(coldLoad.files.map(({ path }) => path));
    for (const path of [
      "/build-worker.js",
      "/pack-worker.js",
      "/pack/pyodide/pyodide.asm.wasm.zst",
      "/synth/yosys.wasm.zst",
      "/openFPGALoader.mjs",
      "/openFPGALoader.wasm",
    ]) {
      expect(coldLoadPaths, `missing cold-load request ${path}`).toContain(path);
    }
    console.log(
      `S4_FIRST_LOAD_BYTES ${JSON.stringify({
        board: board.id,
        node: process.version,
        chromium: page.context().browser().version(),
        ...coldLoad,
      })}`,
    );
    writeFileSync(
      resolve(root, `build/s4-first-load-${board.id}.json`),
      `${JSON.stringify({
        board: board.id,
        node: process.version,
        chromium: page.context().browser().version(),
        ...coldLoad,
      }, null, 2)}\n`,
    );
  });
}

test("missing chipdb fails asset integrity before placement and routing", async ({
  page,
}) => {
  const board = BOARDS[0];
  await createProject(page, board);
  await page.route("**/synth/chipdb/chipdb-GW1NZ-1.bin.zst", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/octet-stream",
      body: "",
    }),
  );
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 30_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "Could not load synthesis asset chipdb/chipdb-GW1NZ-1.bin (404)",
  );
});

test("corrupted compressed synthesis asset fails its SHA-256 check", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  const compressed = Buffer.from(
    readFileSync(resolve(root, "dist/synth/yosys.wasm.zst")),
  );
  compressed[Math.floor(compressed.byteLength / 2)] ^= 1;
  await page.route("**/synth/yosys.wasm.zst", (route) =>
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
    "Synthesis asset compressed SHA-256 mismatch for yosys.wasm",
  );
});

test("corrupted cached synthesis asset is discarded and refetched", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  const manifest = JSON.parse(
    readFileSync(resolve(root, "dist/synth/manifest.json"), "utf8"),
  );
  const asset = manifest.assets.find(({ path }) => path === "yosys.wasm");
  await page.evaluate(async (sha256) => {
    const cache = await caches.open("gogo-fpga-synth-v1");
    const key = new URL(`synth/yosys.wasm?sha256=${sha256}`, location.href);
    await cache.put(
      key,
      new Response("corrupt cached content", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }, asset.sha256);
  let compressedRequests = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/synth/") && url.pathname.endsWith(".zst")) {
      compressedRequests += 1;
    }
  });
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  expect(compressedRequests).toBe(4);
});

test("cached synthesis assets survive a page reload", async ({ page }) => {
  const board = BOARDS[0];
  const projectName = await createProject(page, board);
  const expectedBytes = readFileSync(resolve(expectedRoot, `${board.id}.fs`));
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  const firstResult = await storedFsDigest(page, projectName);
  await page.reload();
  await expect(
    page.locator(`#project-select option[value="${projectName}"]`),
  ).toBeAttached();
  await page.locator("#project-select").selectOption(projectName);
  await expect(page.locator("#project-name")).toHaveText(projectName);

  let compressedRequests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith(".zst")) compressedRequests += 1;
  });
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  expect(await storedFsDigest(page, projectName)).toEqual(firstResult);
  expect(firstResult.size).toBe(expectedBytes.length);
  expect(compressedRequests).toBe(0);
});

test("cached pack assets survive a page reload", async ({ page }) => {
  const board = BOARDS[0];
  const projectName = await createProject(page, board);
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  const firstResult = await storedFsDigest(page, projectName);
  await page.reload();
  await expect(
    page.locator(`#project-select option[value="${projectName}"]`),
  ).toBeAttached();
  await page.locator("#project-select").selectOption(projectName);
  await expect(page.locator("#project-name")).toHaveText(projectName);

  const networkResponses = await captureNetworkResponses(page.context());
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  expect(await storedFsDigest(page, projectName)).toEqual(firstResult);
  const packAssetRequests = networkResponses.filter(
    ({ path }) =>
      path.startsWith("/pack/") &&
      path !== "/pack/manifest.json" &&
      !path.endsWith(".mjs"),
  );
  expect(packAssetRequests).toEqual([]);
  expect(networkResponses.some(({ path }) => path === "/pack/pyodide/pyodide.mjs")).toBe(
    true,
  );
});

test("corrupt compressed pack asset fails, then a corrupt cache entry is refetched", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  const manifest = JSON.parse(
    readFileSync(resolve(root, "dist/pack/manifest.json"), "utf8"),
  );
  const asset = manifest.assets.find(
    ({ path }) => path === "pyodide/pyodide.asm.wasm",
  );
  const compressed = Buffer.from(
    readFileSync(resolve(root, "dist/pack/pyodide/pyodide.asm.wasm.zst")),
  );
  compressed[Math.floor(compressed.byteLength / 2)] ^= 1;
  const compressedRoute = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      body: compressed,
    });
  await page.route(
    "**/pack/pyodide/pyodide.asm.wasm.zst",
    compressedRoute,
  );
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド失敗", {
    timeout: 30_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "Pack asset compressed SHA-256 mismatch for pyodide/pyodide.asm.wasm",
  );
  await page.unroute(
    "**/pack/pyodide/pyodide.asm.wasm.zst",
    compressedRoute,
  );
  await page.evaluate(async (sha256) => {
    const cache = await caches.open("gogo-fpga-pack-v1");
    const key = new URL(
      `pack/pyodide/pyodide.asm.wasm?sha256=${sha256}`,
      location.href,
    );
    await cache.put(
      key,
      new Response("corrupt cached content", {
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
  }, asset.sha256);

  const networkResponses = await captureNetworkResponses(page.context());
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  expect(
    networkResponses.some(
      ({ path }) => path === "/pack/pyodide/pyodide.asm.wasm.zst",
    ),
  ).toBe(true);
});

test("cancelled browser build can be followed by a successful build", async ({
  page,
}) => {
  await createProject(page, BOARDS[0]);
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("合成", {
    timeout: 10_000,
  });
  await page.screenshot({ path: resolve(screenshots, "mid-build.png") });
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("中止しました");
  await page.unrouteAll();
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
});

test("390 pixel layout stays usable during and after a browser build", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createProject(page, BOARDS[0]);
  await page.locator("#synthesis-button").click();
  await expect(page.locator("#synthesis-stage")).not.toBeEmpty();
  await page.screenshot({ path: resolve(screenshots, "390px-during.png") });
  await expect(page.locator("#synthesis-stage")).toHaveText("ビルド完了", {
    timeout: 140_000,
  });
  await page.screenshot({ path: resolve(screenshots, "390px-after.png") });
});
