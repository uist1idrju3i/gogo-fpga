// Measures in-browser decompression time of the large web assets for each format.
// Usage: node scripts/bench-decompress.mjs --base-url http://127.0.0.1:8000 --repeats 5 --out <csv>
// Requires dist/bench/ from scripts/prepare-compressed-assets.sh and dist/serve.py running.
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    repeats: { type: "string", default: "5" },
    out: { type: "string" },
    "run-id": { type: "string", default: "S4B" },
  },
});
const baseURL = values["base-url"];
const repeats = Number(values.repeats);
if (!baseURL || !values.out || !Number.isInteger(repeats) || repeats < 1) {
  throw new Error("--base-url, --out and a positive integer --repeats are required");
}
if (existsSync(values.out)) throw new Error(`${values.out} already exists; refusing to overwrite`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto(new URL("/index.html", baseURL).href);
const rows = await page.evaluate(async ({ repeats }) => {
  const { decompress } = await import("/lib/decompress.mjs");
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
  const index = (await (await fetch("/bench/index.tsv")).text()).trim().split("\n").slice(1)
    .map((line) => {
      const [path, size, sha256, format, compressedSize, compressedSha256] = line.split("\t");
      return { path, size: Number(size), sha256, format, compressedSize: Number(compressedSize), compressedSha256 };
    });
  const ext = { gzip: "gz", zstd: "zst", xz: "xz" };
  const formats = ["gzip", "zstd", "xz"];
  const inputs = new Map();
  for (const entry of index) {
    const url = `/bench/${entry.path.replaceAll("/", "_")}.${ext[entry.format]}`;
    const bytes = new Uint8Array(await (await fetch(url, { cache: "no-store" })).arrayBuffer());
    if (bytes.byteLength !== entry.compressedSize) throw new Error(`size mismatch for ${url}`);
    if (hex(await crypto.subtle.digest("SHA-256", bytes)) !== entry.compressedSha256) {
      throw new Error(`compressed SHA-256 mismatch for ${url}`);
    }
    inputs.set(`${entry.format}:${entry.path}`, { entry, bytes });
  }
  const out = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const order = formats.map((_, i) => formats[(i + repeat - 1) % formats.length]);
    for (const format of order) {
      for (const { entry, bytes } of [...inputs.values()].filter((v) => v.entry.format === format)) {
        const t0 = performance.now();
        const result = await decompress(format, bytes.slice(), entry.size);
        const ms = performance.now() - t0;
        const ok = hex(await crypto.subtle.digest("SHA-256", result)) === entry.sha256;
        out.push({ variant: format, repeat, path: entry.path, ms, ok, compressedSize: entry.compressedSize });
      }
    }
  }
  for (const format of formats) {
    const { entry, bytes } = inputs.get(`${format}:synth/yosys.wasm`);
    const broken = bytes.slice();
    broken[broken.length >> 1] ^= 0x01;
    let outcome;
    try {
      const result = await decompress(format, broken, entry.size);
      outcome = hex(await crypto.subtle.digest("SHA-256", result)) === entry.sha256 ? "undetected" : "sha256-mismatch";
    } catch (error) {
      outcome = `threw:${String(error.message ?? error).slice(0, 80)}`;
    }
    out.push({ variant: format, repeat: 0, path: "negative-control:synth/yosys.wasm", ms: 0, ok: outcome !== "undetected", note: outcome });
  }
  return out;
}, { repeats });
const version = browser.version();
await browser.close();

const lines = ["run_id,variant,repeat,metric,value,unit,valid,note"];
for (const row of rows) {
  const note = row.note ?? `${row.path} compressed=${row.compressedSize}`;
  lines.push([values["run-id"], row.variant, row.repeat, "decompress_ms", row.ms.toFixed(1), "ms", row.ok, `"${note.replaceAll('"', "'")} chromium=${version}"`].join(","));
}
writeFileSync(values.out, `${lines.join("\n")}\n`);
console.log(`wrote ${rows.length} rows to ${values.out}`);
if (rows.some((row) => !row.ok)) process.exitCode = 1;
