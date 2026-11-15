import { defineConfig } from "@playwright/test";
const out = process.env.FORMAL_BROWSER_OUT;
const baseURL = process.env.FORMAL_BROWSER_BASE_URL;
const csp = process.env.FORMAL_BROWSER_SUITE === "csp";
if (!out || !baseURL) throw new Error("run-targeted.mjsから起動してください。");
export default defineConfig({
  testDir: "../../tests/e2e",
  testMatch: csp ? ["openrouter-auth.spec.mjs"] : ["vhdl.spec.mjs", "simulation.spec.mjs"],
  grep: csp ? /CSP permits real built-in SAT formal success and counterexamples/
    : /VHDL formal sources remain selectable|VHDL-only is disabled and mixed projects/,
  repeatEach: csp ? 5 : 1,
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
