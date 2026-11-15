import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

// 新しい出力先だけを作り、過去の受入れ証拠の上書きを防ぐ。
export function prepareEvidence(out, baseURL = "http://127.0.0.1:8123/") {
  if (!out) throw new Error("新しい出力先を指定してください。");
  const url = new URL(baseURL);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("配信URLはHTTPまたはHTTPSで指定してください。");
  }
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: new URL("../../", import.meta.url), encoding: "utf8",
  }).trim();
  const output = resolve(out);
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(output); // EEXISTなら、空の既存ディレクトリーでも停止する。
  writeFileSync(resolve(output, "setup.json"), JSON.stringify({
    revision, baseURL: url.href, startedAt: new Date().toISOString(),
  }, null, 2), { flag: "wx" });
  return { out: output + sep, baseURL: url.href, revision };
}

export function interactiveEvidence() {
  const { values } = parseArgs({ options: {
    out: { type: "string" }, "base-url": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    console.log("node <script.mjs> --out <新しい出力先> [--base-url http://127.0.0.1:8123/]");
    process.exit(0);
  }
  return prepareEvidence(values.out, values["base-url"]);
}
