import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { prepareEvidence } from "./evidence.mjs";

const { values } = parseArgs({ options: {
  out: { type: "string" }, "base-url": { type: "string" },
  list: { type: "boolean" }, help: { type: "boolean", short: "h" },
  csp: { type: "boolean" },
} });
if (values.help) {
  console.log("node tests/browser-acceptance/run-targeted.mjs --out <新しい出力先> [--base-url <配信URL>] [--list] [--csp]");
  process.exit(0);
}

// Playwrightが出力を消去・設定を再評価する前に、一度だけ証拠用の場所を確保する。
const { out, baseURL } = prepareEvidence(values.out, values["base-url"]);
const result = spawnSync(process.execPath, [
  fileURLToPath(new URL("./cli.js", import.meta.resolve("playwright/package.json"))),
  "test", "--config", fileURLToPath(new URL("./targeted.config.mjs", import.meta.url)),
  ...(values.list ? ["--list"] : []),
], {
  cwd: new URL("../../", import.meta.url),
  env: { ...process.env, FORMAL_BROWSER_OUT: out, FORMAL_BROWSER_BASE_URL: baseURL,
    FORMAL_BROWSER_SUITE: values.csp ? "csp" : "vhdl" },
  stdio: "inherit",
});
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
