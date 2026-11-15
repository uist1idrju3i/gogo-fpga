import { defineConfig } from "@playwright/test";
const out = process.env.FORMAL_BROWSER_OUT;
const baseURL = process.env.FORMAL_BROWSER_BASE_URL;
if (!out || !baseURL) throw new Error("run-targeted.mjsから起動してください。");
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: ["vhdl.spec.mjs", "simulation.spec.mjs"],
  grep: /VHDL formal sources remain selectable|VHDL-only is disabled and mixed projects/,
  workers: 1,
  timeout: 150000,
  expect: { timeout: 30000 },
  outputDir: out + "results",
  reporter: [["list"], ["json", {outputFile: out + "results.json"}]],
  use: {
    baseURL,
    browserName: "chromium", headless: false, locale: "ja-JP",
    viewport: {width:1400,height:950},
    launchOptions: {args:["--lang=ja-JP"]},
    screenshot: "on", trace: "on"
  }
});
