import { defineConfig, devices } from "@playwright/test";

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? "8000");
if (!Number.isInteger(playwrightPort) || playwrightPort < 1 || playwrightPort > 65535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer between 1 and 65535.");
}
const baseURL = `http://127.0.0.1:${playwrightPort}`;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/synthesis-setup.mjs",
  ...(process.env.S5_PLAYWRIGHT_OUTPUT_DIR
    ? { outputDir: process.env.S5_PLAYWRIGHT_OUTPUT_DIR }
    : {}),
  timeout: 150_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    browserName: "chromium",
    headless: true,
    locale: "ja-JP",
    launchOptions: { args: ["--lang=ja-JP"] },
    trace: "retain-on-failure",
  },
  webServer: {
    command: `scripts/build-web.sh && python3 dist/serve.py --port ${playwrightPort}`,
    url: baseURL,
    reuseExistingServer: false,
    stdout: "pipe",
    timeout: 120_000,
  },
});
