// Measures decoder compilation and asset decompression in Chromium for each S6 variant.
// Use --smoke with one --assets path to check variant outputs without recording timings.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const repoRoot = resolve(import.meta.dirname, "..");
const defaultVariants = ["B", "B2", "O3", "O3LTO", "Os", "OsLTO"];
const defaultAssets = [
  "synth/yosys.wasm",
  "synth/nextpnr-himbaechel-gowin.wasm",
  "synth/yosys-share.tar",
  "pack/pyodide/pyodide.asm.wasm",
  "synth/chipdb/chipdb-GW2A-18C.bin",
];
const formats = ["zstd", "xz"];
const { values } = parseArgs({
  options: {
    "base-url": { type: "string" },
    "decoder-root": { type: "string", default: "build/s6/variants" },
    variants: { type: "string", default: defaultVariants.join(",") },
    assets: { type: "string", default: defaultAssets.join(",") },
    repeats: { type: "string", default: "5" },
    out: { type: "string" },
    "run-id": { type: "string", default: "S6" },
    smoke: { type: "boolean", default: false },
  },
});

const baseURL = values["base-url"];
const repeats = Number(values.repeats);
const variants = values.variants.split(",").map((value) => value.trim()).filter(Boolean);
const assets = values.assets.split(",").map((value) => value.trim()).filter(Boolean);
const decoderRoot = resolve(repoRoot, values["decoder-root"]);
const smoke = values.smoke;
const outPath = values.out ? resolve(repoRoot, values.out) : undefined;

if (!baseURL || !Number.isInteger(repeats) || repeats < 1) {
  throw new Error("--base-url and a positive integer --repeats are required");
}
new URL(baseURL);
if (!variants.length || new Set(variants).size !== variants.length) {
  throw new Error("--variants must contain unique variant names");
}
if (variants.some((variant) => !defaultVariants.includes(variant))) {
  throw new Error(`--variants must be selected from ${defaultVariants.join(",")}`);
}
if (!assets.length || new Set(assets).size !== assets.length) {
  throw new Error("--assets must contain unique asset paths");
}
if (smoke && assets.length !== 1) {
  throw new Error("--smoke requires exactly one --assets path");
}
if (smoke && outPath) {
  throw new Error("--out is not allowed with --smoke; smoke mode does not write timing results");
}
if (!smoke && !outPath) {
  throw new Error("--out is required unless --smoke is used");
}
if (outPath && existsSync(outPath)) {
  throw new Error(`${values.out} already exists; refusing to overwrite`);
}

const variantPayloads = variants.map((variant) => {
  const wasm = {};
  for (const format of ["zstd", "xz"]) {
    const path = resolve(decoderRoot, variant, `${format}-decoder.wasm`);
    const bytes = readFileSync(path);
    wasm[format] = {
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    };
  }
  return { name: variant, wasm };
});

const rows = [];
for (const variant of variantPayloads) {
  for (const format of ["zstd", "xz"]) {
    const decoder = variant.wasm[format];
    rows.push({
      runId: values["run-id"],
      variant: variant.name,
      repeat: 0,
      format,
      asset: "",
      metric: "decoder_bytes",
      value: decoder.byteLength,
      unit: "bytes",
      valid: true,
      decoderSha256: decoder.sha256,
      expectedSha256: "",
      actualSha256: "",
      note: "",
    });
  }
}

const browser = await chromium.launch({ headless: true });
const chromiumVersion = browser.version();
const smokeRows = [];
let pageFailure = false;
try {
  const runCount = smoke ? 1 : repeats;
  for (let repeat = 1; repeat <= runCount; repeat += 1) {
    let page;
    try {
      page = await browser.newPage();
      await page.goto(new URL("/index.html", baseURL).href);
      const order = variants.map((_, index) => variants[(index + repeat - 1) % variants.length]);
      const pageRows = await page.evaluate(async (payload) => {
        const { decompress } = await import("/lib/decompress.mjs");
        const hex = (bytes) =>
          Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
        const sha256 = async (bytes) => hex(await crypto.subtle.digest("SHA-256", bytes));
        const fromBase64 = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
        const decoderBytesForWasiImports = new WeakSet();
        const nativeInstantiate = WebAssembly.instantiate.bind(WebAssembly);
        WebAssembly.instantiate = async (source, imports) => {
          if (!decoderBytesForWasiImports.has(source)) {
            return imports === undefined
              ? nativeInstantiate(source)
              : nativeInstantiate(source, imports);
          }
          let instance;
          const randomGet = (pointer, length) => {
            const memory = instance?.exports.memory;
            if (!(memory instanceof WebAssembly.Memory)) return 21;
            let view;
            try {
              view = new Uint8Array(memory.buffer, pointer >>> 0, length >>> 0);
            } catch {
              return 21;
            }
            for (let offset = 0; offset < view.length; offset += 65_536) {
              crypto.getRandomValues(view.subarray(offset, Math.min(offset + 65_536, view.length)));
            }
            return 0;
          };
          const result = await nativeInstantiate(source, {
            ...(imports ?? {}),
            wasi_snapshot_preview1: {
              ...(imports?.wasi_snapshot_preview1 ?? {}),
              random_get: randomGet,
            },
          });
          instance = result.instance;
          return result;
        };
        const indexResponse = await fetch("/bench/index.tsv", { cache: "no-store" });
        if (!indexResponse.ok) {
          throw new Error(`Could not load benchmark index: HTTP ${indexResponse.status}`);
        }
        const index = (await indexResponse.text()).trim().split("\n").slice(1).map((line) => {
          const [path, size, assetSha256, format, compressedSize, compressedSha256] = line.split("\t");
          return {
            path,
            size: Number(size),
            assetSha256,
            format,
            compressedSize: Number(compressedSize),
            compressedSha256,
          };
        });
        const inputs = new Map();
        for (const path of payload.assets) {
          for (const format of ["zstd", "xz"]) {
            const entry = index.find((candidate) => candidate.path === path && candidate.format === format);
            if (!entry) throw new Error(`Asset is absent from benchmark index: ${format}:${path}`);
            const name = path.replaceAll("/", "_");
            const extension = format === "zstd" ? "zst" : "xz";
            const url = `/bench/${name}.${extension}`;
            const response = await fetch(url, { cache: "no-store" });
            if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.byteLength !== entry.compressedSize) {
              throw new Error(`Compressed size mismatch for ${format}:${path}`);
            }
            if ((await sha256(bytes)) !== entry.compressedSha256) {
              throw new Error(`Compressed SHA-256 mismatch for ${format}:${path}`);
            }
            inputs.set(`${format}:${path}`, { entry, bytes });
          }
        }

        const output = [];
        const payloadByName = new Map(payload.variants.map((variant) => [variant.name, variant]));
        for (const variantName of payload.order) {
          const variant = payloadByName.get(variantName);
          for (const format of ["zstd", "xz"]) {
            const decoder = variant.wasm[format];
            const decoderBytes = fromBase64(decoder.base64);
            decoderBytesForWasiImports.add(decoderBytes);
            if (payload.smoke) {
              for (const path of payload.assets) {
                const { entry, bytes } = inputs.get(`${format}:${path}`);
                try {
                  const result = await decompress(format, bytes.slice(), entry.size, { decoderBytes });
                  const actualSha256 = await sha256(result);
                  output.push({
                    variant: variantName,
                    format,
                    asset: path,
                    valid: actualSha256 === entry.assetSha256,
                    decoderSha256: decoder.sha256,
                    expectedSha256: entry.assetSha256,
                    actualSha256,
                    note: "",
                  });
                } catch (error) {
                  output.push({
                    variant: variantName,
                    format,
                    asset: path,
                    valid: false,
                    decoderSha256: decoder.sha256,
                    expectedSha256: entry.assetSha256,
                    actualSha256: "",
                    note: String(error.message ?? error).slice(0, 240),
                  });
                }
              }
              continue;
            }

            try {
              const compileStart = performance.now();
              await WebAssembly.compile(decoderBytes);
              output.push({
                variant: variantName,
                repeat: payload.repeat,
                format,
                asset: "",
                metric: "decoder_compile_ms",
                value: (performance.now() - compileStart).toFixed(3),
                unit: "ms",
                valid: true,
                decoderSha256: decoder.sha256,
                expectedSha256: "",
                actualSha256: "",
                note: "",
              });
            } catch (error) {
              const note = `decoder compile failed: ${String(error.message ?? error).slice(0, 200)}`;
              output.push({
                variant: variantName,
                repeat: payload.repeat,
                format,
                asset: "",
                metric: "decoder_compile_ms",
                value: "",
                unit: "ms",
                valid: false,
                decoderSha256: decoder.sha256,
                expectedSha256: "",
                actualSha256: "",
                note,
              });
              for (const path of payload.assets) {
                const { entry } = inputs.get(`${format}:${path}`);
                output.push({
                  variant: variantName,
                  repeat: payload.repeat,
                  format,
                  asset: path,
                  metric: "decode_ms",
                  value: "",
                  unit: "ms",
                  valid: false,
                  decoderSha256: decoder.sha256,
                  expectedSha256: entry.assetSha256,
                  actualSha256: "",
                  note,
                });
              }
              continue;
            }

            const firstPath = payload.assets[0];
            const firstInput = inputs.get(`${format}:${firstPath}`);
            try {
              const warmup = await decompress(format, firstInput.bytes.slice(), firstInput.entry.size, { decoderBytes });
              if ((await sha256(warmup)) !== firstInput.entry.assetSha256) {
                throw new Error(`Warm-up SHA-256 mismatch for ${format}:${firstPath}`);
              }
            } catch (error) {
              const note = `decoder warm-up failed: ${String(error.message ?? error).slice(0, 200)}`;
              for (const path of payload.assets) {
                const { entry } = inputs.get(`${format}:${path}`);
                output.push({
                  variant: variantName,
                  repeat: payload.repeat,
                  format,
                  asset: path,
                  metric: "decode_ms",
                  value: "",
                  unit: "ms",
                  valid: false,
                  decoderSha256: decoder.sha256,
                  expectedSha256: entry.assetSha256,
                  actualSha256: "",
                  note,
                });
              }
              continue;
            }

            for (const path of payload.assets) {
              const { entry, bytes } = inputs.get(`${format}:${path}`);
              try {
                const start = performance.now();
                const result = await decompress(format, bytes.slice(), entry.size, { decoderBytes });
                const elapsed = performance.now() - start;
                const actualSha256 = await sha256(result);
                output.push({
                  variant: variantName,
                  repeat: payload.repeat,
                  format,
                  asset: path,
                  metric: "decode_ms",
                  value: elapsed.toFixed(3),
                  unit: "ms",
                  valid: actualSha256 === entry.assetSha256,
                  decoderSha256: decoder.sha256,
                  expectedSha256: entry.assetSha256,
                  actualSha256,
                  note: "",
                });
              } catch (error) {
                output.push({
                  variant: variantName,
                  repeat: payload.repeat,
                  format,
                  asset: path,
                  metric: "decode_ms",
                  value: "",
                  unit: "ms",
                  valid: false,
                  decoderSha256: decoder.sha256,
                  expectedSha256: entry.assetSha256,
                  actualSha256: "",
                  note: String(error.message ?? error).slice(0, 240),
                });
              }
            }
          }
        }
        return output;
      }, {
        repeat,
        order,
        variants: variantPayloads,
        assets,
        smoke,
      });

      if (smoke) {
        smokeRows.push(...pageRows);
      } else {
        rows.push(...pageRows.map((row) => ({ runId: values["run-id"], ...row })));
      }
    } catch (error) {
      const note = `page failed: ${String(error.message ?? error).slice(0, 240)}`;
      if (smoke) {
        smokeRows.push(...variants.flatMap((variant) =>
          ["zstd", "xz"].map((format) => ({
            variant,
            format,
            asset: assets[0],
            valid: false,
            decoderSha256: "",
            expectedSha256: "",
            actualSha256: "",
            note,
          })),
        ));
      } else {
        pageFailure = true;
        for (const variant of variants) {
          for (const format of ["zstd", "xz"]) {
            rows.push({
              runId: values["run-id"],
              variant,
              repeat,
              format,
              asset: "",
              metric: "page_failure",
              value: "",
              unit: "",
              valid: false,
              decoderSha256: "",
              expectedSha256: "",
              actualSha256: "",
              note,
            });
          }
        }
      }
    } finally {
      if (page) await page.close();
    }
  }
} finally {
  await browser.close();
}

if (smoke) {
  for (const row of smokeRows) {
    console.log(
      `SMOKE ${row.valid ? "PASS" : "FAIL"} variant=${row.variant} format=${row.format} asset=${row.asset} decoder_sha256=${row.decoderSha256} expected_sha256=${row.expectedSha256} actual_sha256=${row.actualSha256}${row.note ? ` note=${row.note}` : ""}`,
    );
  }
  if (smokeRows.length !== variants.length * 2 || smokeRows.some((row) => !row.valid)) {
    process.exitCode = 1;
  }
} else {
  rows.unshift(
    {
      runId: values["run-id"],
      variant: "",
      repeat: 0,
      format: "",
      asset: "",
      metric: "node_version",
      value: process.version,
      unit: "",
      valid: true,
      decoderSha256: "",
      expectedSha256: "",
      actualSha256: "",
      note: "",
    },
    {
      runId: values["run-id"],
      variant: "",
      repeat: 0,
      format: "",
      asset: "",
      metric: "chromium_version",
      value: chromiumVersion,
      unit: "",
      valid: true,
      decoderSha256: "",
      expectedSha256: "",
      actualSha256: "",
      note: "",
    },
  );
  const columns = [
    "runId",
    "variant",
    "repeat",
    "format",
    "asset",
    "metric",
    "value",
    "unit",
    "valid",
    "decoderSha256",
    "expectedSha256",
    "actualSha256",
    "note",
  ];
  const csv = [
    "run_id,variant,repeat,format,asset,metric,value,unit,valid,decoder_sha256,expected_sha256,actual_sha256,note",
    ...rows.map((row) =>
      columns.map((column) => `"${String(row[column] ?? "").replaceAll('"', '""')}"`).join(","),
    ),
  ].join("\n");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${csv}\n`, { flag: "wx" });
  console.log(`wrote ${rows.length} rows to ${values.out}`);
  if (pageFailure || rows.some((row) => !row.valid)) process.exitCode = 1;
}
