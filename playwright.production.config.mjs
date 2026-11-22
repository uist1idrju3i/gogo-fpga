import { defineConfig, devices } from "@playwright/test";

// Production E2E: runs the e2e suite against the deployed https://fpga.moe site.
// No local webServer and no globalSetup — the site is already built and served.
//
// Tests that need locally-built native baselines or the local dist tree are
// excluded below (they run in CI via playwright.config.mjs):
// - .fs byte comparisons against the native reference build
// - the S5 baseline download comparison and fixture-loaded project builds
// - cached-asset checks that list files in the local dist tree
// - web-flasher.spec.mjs (a pre-flight check on files produced by
//   scripts/build-web.sh)
// Specs that assert every same-origin request maps to a file in public_html/
// need a mirror of the deployed tree: `git archive origin/pages | tar -x -C .`
// restores public_html/ to the deployed content.
//
// Usage: PLAYWRIGHT_ASSET_HOST=fpga.moe npx playwright test \
//   --config playwright.production.config.mjs

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /web-flasher\.spec\.mjs/,
  grepInvert:
    /built distribution|native \.fs|native-identical|S5 Chromium build matches the baseline|fixture-loaded project|cached synthesis assets survive/,
  timeout: 180_000,
  expect: {
    timeout: 45_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "https://fpga.moe",
    browserName: "chromium",
    headless: true,
    locale: "ja-JP",
    launchOptions: { args: ["--lang=ja-JP"] },
    trace: "retain-on-failure",
  },
});
