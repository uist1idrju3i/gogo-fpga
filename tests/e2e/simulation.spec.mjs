import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const dist = resolve(root, "dist");
const screenshots = resolve(root, "build/T4-ui/screens");
const alternateVcd = readFileSync(resolve(root, "tests/fixtures/surfer/logic.vcd"), "utf8");
const finiteTestbench = [
  "`timescale 1ns/1ps",
  "module top_tb;",
  "  reg clk = 1'b0;",
  "  wire led;",
  "  top uut (.clk(clk), .led(led));",
  "  always #5 clk = ~clk;",
  "  initial begin",
  "    $dumpfile(\"wave.vcd\");",
  "    $dumpvars(0, top_tb);",
  "    #100;",
  "    $finish;",
  "  end",
  "endmodule",
].join("\n");
const infiniteTestbench = [
  "`timescale 1ns/1ps",
  "module top_tb;",
  "  reg clk = 1'b0;",
  "  wire led;",
  "  top uut (.clk(clk), .led(led));",
  "  always #5 clk = ~clk;",
  "  initial begin",
  "    $dumpfile(\"wave.vcd\");",
  "    $dumpvars(0, top_tb);",
  "  end",
  "endmodule",
].join("\n");
mkdirSync(screenshots, { recursive: true });

test.use({
  launchOptions: {
    args: ["--lang=ja-JP", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  },
});

function captureRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    requests.push({ url: request.url(), method: request.method() });
  });
  return requests;
}

function assertStaticRequests(page, requests) {
  const origin = new URL(page.url()).origin;
  for (const { url: value, method } of requests) {
    const url = new URL(value);
    if (url.protocol === "blob:") {
      expect(url.origin).toBe(origin);
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    expect(url.origin).toBe(origin);
    expect(method).toBe("GET");
    const path = decodeURIComponent(url.pathname);
    const relative = path === "/" ? "index.html" : path.slice(1);
    const file = resolve(dist, relative);
    expect(file.startsWith(`${dist}${sep}`)).toBe(true);
    expect(existsSync(file), `${path} must be present in dist`).toBe(true);
  }
}

async function openIde(page) {
  await page.goto("/");
  await expect(page.locator("#project-name")).toHaveText("blink");
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
}

async function createProject(page, board, language = "verilog") {
  const name = `sim-${board}-${randomUUID().slice(0, 8)}`;
  await page.locator("#new-project-button").click();
  await page.locator("#new-project-name").fill(name);
  await page.locator("#new-project-board").selectOption(board);
  await page.locator("#new-project-language").selectOption(language);
  await page.locator("#new-project-create").click();
  await expect(page.locator("#project-name")).toHaveText(name);
  await expect(page.locator("#project-status")).toHaveText("保存しました。");
  return name;
}

async function replaceFile(page, path, contents) {
  await page.getByRole("button", { name: `${path} を開く` }).click();
  const editor = page.locator(".cm-content");
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(contents);
  await expect(page.locator("#project-status")).toHaveText("保存しました。", {
    timeout: 10_000,
  });
}

async function waitForWaveform(page, signal = "top_tb.clk") {
  await page.locator("#bottom-tab-waveform").click();
  await expect.poll(() => page.frames().some((candidate) =>
    candidate.url().endsWith("/surfer/index.html")
  )).toBe(true);
  const frame = page.frames().find((candidate) =>
    candidate.url().endsWith("/surfer/index.html")
  );
  expect(frame).toBeTruthy();
  await expect.poll(
    () => frame.evaluate(async () => {
      const m = await import("/surfer/surfer.js");
      return m.waves_loaded();
    }),
    { timeout: 10_000 },
  ).toBe(true);
  await expect.poll(
    () => frame.evaluate(async (signalName) => {
      const m = await import("/surfer/surfer.js");
      return m.index_of_name(signalName);
    }, signal),
    { timeout: 10_000 },
  ).toBeGreaterThanOrEqual(0);
  return frame;
}

test("each board template simulates and loads a top_tb waveform", async ({ page }) => {
  const requests = captureRequests(page);
  await openIde(page);
  for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
    if (board !== "tangnano1k") {
      await page.goto("/");
      await openIde(page);
    }
    await createProject(page, board);
    await expect(page.locator("#simulation-button")).toBeEnabled();
    await page.locator("#simulation-button").click();
    await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok", {
      timeout: 30_000,
    });
    await expect(page.locator("#wave-download-link")).toHaveAttribute("download", "wave.vcd");
    await waitForWaveform(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(
      () => page.locator("#bottom-panel-waveform").evaluate((panel) =>
        panel.getBoundingClientRect().height
      ),
    ).toBeGreaterThanOrEqual(420);
    await page.locator("#bottom-panel-waveform").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(screenshots, `${board}-desktop.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(
      () => page.locator("#bottom-panel-waveform").evaluate((panel) =>
        panel.getBoundingClientRect().height
      ),
    ).toBeGreaterThanOrEqual(420);
    await page.locator("#bottom-panel-waveform").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: resolve(screenshots, `${board}-mobile.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  assertStaticRequests(page, requests);
});

test("Icarus syntax diagnostics point to the project file and source line", async ({ page }) => {
  const requests = captureRequests(page);
  await openIde(page);
  await replaceFile(
    page,
    "src/top.v",
    "`timescale 1ns/1ps\nmodule top;\n  wire a;\n  assign a = ;\nendmodule\n",
  );
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "failed", {
    timeout: 15_000,
  });
  await page.locator("#bottom-tab-problems").click();
  await expect(page.locator("#problem-list")).toContainText("src/top.v:4");
  await expect(page.locator("#problem-list")).toContainText("syntax error");
  assertStaticRequests(page, requests);
});

test("a successful run without VCD reports the dumpfile guidance", async ({ page }) => {
  const requests = captureRequests(page);
  await openIde(page);
  await replaceFile(
    page,
    "src/top_tb.v",
    "`timescale 1ns/1ps\nmodule top_tb;\n  initial begin\n    #10;\n    $finish;\n  end\nendmodule\n",
  );
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "failed", {
    timeout: 15_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "VCD が出力されていません。testbench の $dumpfile と $dumpvars を確かめてください。",
  );
  assertStaticRequests(page, requests);
});

test("stop terminates the worker, reruns successfully, and the time limit is enforced", async ({
  page,
}) => {
  const requests = captureRequests(page);
  await openIde(page);
  await replaceFile(page, "src/top_tb.v", infiniteTestbench);
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-button")).toHaveText("停止");
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "stopped", {
    timeout: 10_000,
  });
  await expect(page.locator("#simulation-button")).toHaveText("シミュレーション");
  await replaceFile(page, "src/top_tb.v", finiteTestbench);
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok", {
    timeout: 15_000,
  });
  await replaceFile(page, "src/top_tb.v", infiniteTestbench);
  await page.locator("#simulation-time-limit").fill("1");
  await page.locator("#simulation-time-limit").dispatchEvent("change");
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "timeout", {
    timeout: 10_000,
  });
  await expect(page.locator("#simulation-status")).toContainText("時間上限に達しました。");
  assertStaticRequests(page, requests);
});

test("VHDL-only is disabled and mixed projects log VHDL exclusion", async ({ page }) => {
  const requests = captureRequests(page);
  await openIde(page);
  await createProject(page, "tangnano1k", "vhdl");
  await expect(page.locator("#simulation-button")).toBeDisabled();
  await expect(page.locator("#simulation-reason")).toHaveText(
    "VHDL のシミュレーションはできません（Verilog の testbench を使ってください）",
  );
  await createProject(page, "tangnano1k", "verilog");
  await page.locator("#add-file-button").click();
  await page.locator("#file-path-input").fill("src/ignored.vhd");
  await page.locator("#file-path-save").click();
  await expect(page.locator("#file-list")).toContainText("src/ignored.vhd");
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok", {
    timeout: 15_000,
  });
  await expect(page.locator("#program-log")).toContainText(
    "VHDL ファイルはシミュレーションから除外しました。",
  );
  assertStaticRequests(page, requests);
});

test("all VCD outputs can be selected and downloaded without leaking across projects", async ({ page }) => {
  const requests = captureRequests(page);
  await openIde(page);
  await replaceFile(page, "src/top_tb.v", finiteTestbench
    .replace("module top_tb;", "module top_tb;\n  integer output_fd;")
    .replace("    #100;", [
      '    output_fd = $fopen("alternate.vcd", "w");',
      `    $fwrite(output_fd, ${JSON.stringify(alternateVcd)});`,
      "    $fclose(output_fd);",
      "    #100;",
    ].join("\n")));
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
  await waitForWaveform(page);
  const selection = page.locator("#waveform-file");
  await expect(selection.locator("option")).toHaveCount(2);
  const alternate = await selection.locator("option").filter({ hasText: "alternate.vcd" }).getAttribute("value");
  await selection.selectOption(alternate);
  await waitForWaveform(page, "logic.clk");
  await page.locator("#bottom-tab-artifacts").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#wave-download-link").click(),
  ]);
  expect(download.suggestedFilename()).toBe("alternate.vcd");
  expect(readFileSync(await download.path(), "utf8")).toBe(alternateVcd);
  await page.locator("#bottom-tab-waveform").click();
  const original = await selection.locator("option").filter({ hasText: "wave.vcd" }).getAttribute("value");
  await selection.selectOption(original);
  await selection.selectOption(alternate);
  await selection.selectOption(original);
  await waitForWaveform(page);
  await createProject(page, "tangnano4k");
  await expect(page.locator("#waveform-file-field")).toBeHidden();
  await expect(page.locator("#wave-download")).toBeHidden();
  await expect(page.locator("#surfer-frame")).toHaveCount(0);
  assertStaticRequests(page, requests);
});

test("switching project stops an active simulation and ignores its stale result", async ({ page }) => {
  await openIde(page);
  await replaceFile(page, "src/top_tb.v", infiniteTestbench);
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "running");
  await createProject(page, "tangnano9k");
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "");
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
  await waitForWaveform(page);
});

test("license links include Surfer and its generated dependency notices", async ({ page, request }) => {
  await openIde(page);
  await page.locator("#licenses summary").click();
  for (const link of await page.locator("#licenses a").all()) {
    const href = await link.getAttribute("href");
    const response = await request.get(href);
    expect(response.status()).toBe(200);
    expect(await response.text()).not.toHaveLength(0);
  }
  await expect(page.locator("#licenses")).toContainText("Surfer（EUPL-1.2）");
});

test("a malformed VCD is not reported as a loaded waveform", async ({ page }) => {
  test.setTimeout(65_000);
  await openIde(page);
  await replaceFile(page, "src/top_tb.v", [
    "module top_tb;",
    "  integer output_fd;",
    "  initial begin",
    '    output_fd = $fopen("broken.vcd", "w");',
    '    $fwrite(output_fd, "this is not a VCD");',
    "    $fclose(output_fd);",
    "    $finish;",
    "  end",
    "endmodule",
  ].join("\n"));
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
  await page.locator("#bottom-tab-waveform").click();
  await expect(page.locator("#waveform-status")).toContainText("タイムアウト", { timeout: 45_000 });
  const frame = page.frames().find((candidate) => candidate.url().endsWith("/surfer/index.html"));
  expect(await frame.evaluate(async () => (await import("/surfer/surfer.js")).waves_loaded())).toBe(false);
  await page.locator("#bottom-tab-artifacts").click();
  await expect(page.locator("#wave-download-link")).toHaveAttribute("download", "broken.vcd");
});

test("VCD download remains available when WebGL is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (["webgl", "webgl2", "experimental-webgl"].includes(type)) return null;
      return getContext.call(this, type, ...args);
    };
  });
  await openIde(page);
  await page.locator("#simulation-button").click();
  await expect(page.locator("#simulation-status")).toHaveAttribute("data-outcome", "ok");
  await page.locator("#bottom-tab-waveform").click();
  await expect(page.locator("#waveform-status")).toContainText("WebGL が使えない");
  await expect(page.locator("#surfer-frame")).toHaveCount(0);
  await page.locator("#bottom-tab-artifacts").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#wave-download-link").click(),
  ]);
  expect(download.suggestedFilename()).toBe("wave.vcd");
  expect(readFileSync(await download.path(), "utf8")).toContain("$scope module top_tb");
});
