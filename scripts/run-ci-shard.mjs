import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { run } from "node:test";
import { pathToFileURL } from "node:url";
import { containers, packFiles, parsePackShard, plan, root } from "./ci-shard-plan.mjs";
import { playwrightTests } from "./check-ci-shards.mjs";

function prepareOutput(destination) {
  const output = path.resolve(destination);
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output);
  return { output, write: (name, value) => writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" }) };
}

export async function runPack(setting, destination, files = packFiles) {
  process.env.PACK_SHARD = parsePackShard(setting);
  const { output, write } = prepareOutput(destination);
  process.env.CI_SHARD_REPORT_DIR = output;
  const passed = [], failures = [], durations = [];
  let complete = false;
  for await (const event of run({ files, concurrency: 1, execArgv: [] })) {
    const { name, skip, todo, details } = event.data;
    if (event.type === "test:summary") {
      complete = true;
      if (event.data.counts.failed || event.data.counts.cancelled) failures.push(event.data);
    }
    if (event.type === "test:pass" && !skip && !todo && !containers.includes(name)) {
      passed.push(name);
      durations.push({ name, milliseconds: details.duration_ms });
      console.log(`PASS ${name} ${details.duration_ms} ms`);
    }
    if (event.type === "test:fail") { failures.push(event.data); console.error(event.data); }
    if (event.type === "test:stdout") process.stdout.write(event.data.message);
    if (event.type === "test:stderr") process.stderr.write(event.data.message);
  }
  const catalog = files.flatMap((file) => readFileSync(path.join(output, `${path.basename(file)}.jsonl`), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line))).sort((a, b) => a.name.localeCompare(b.name, "en"));
  write("result.json", { shard: setting, catalog, passed, failures, complete, durations });
  if (!complete || failures.length) process.exitCode = 1;
}

export function runE2e(setting, destination) {
  const shard = Number(setting);
  assert.ok(Number.isInteger(shard) && shard >= 1 && shard <= plan.e2e.length);
  const { output, write } = prepareOutput(destination);
  const invoke = (args, name) => {
    const result = spawnSync("npx", ["playwright", "test", ...args, "--reporter=json"], {
      cwd: root, stdio: "inherit", env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, name) },
    });
    assert.equal(result.status, 0, `Playwright ${name} failed: ${result.error ?? result.signal ?? result.status}`);
    return playwrightTests(JSON.parse(readFileSync(path.join(output, name))));
  };
  const full = invoke(["--list"], "full.json").map(({ results, ...test }) => test);
  const patterns = plan.e2e[shard - 1].map((file) => `(?:^|/)tests/e2e/${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const actual = invoke([...patterns, "--retries=0"], "actual.json");
  write("result.json", { shard, full, actual, complete: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [kind, setting, destination] = process.argv.slice(2);
  assert.ok(destination && (kind === "pack" || kind === "e2e"));
  if (kind === "pack") await runPack(setting, destination);
  else runE2e(setting, destination);
}
