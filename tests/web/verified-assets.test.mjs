import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import {
  createVerifiedAssetLoader,
  verifyManifest,
} from "../../web/lib/verified-assets.mjs";

const digest = "a".repeat(64);
test("verified downloads report actual byte progress and verified cache hits", async (t) => {
  const bytes = Uint8Array.of(1, 2, 3, 4);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const assets = new Map([["tool.wasm", { path: "tool.wasm", size: bytes.length, sha256 }]]);
  const progress = [];
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests += 1; return new Response(bytes); });
  const loader = createVerifiedAssetLoader({
    baseURL: new URL("https://example.test/tools/"), cacheName: "test", cacheRaw: true,
    onProgress: (value) => progress.push(value),
  });
  assert.deepEqual(await loader.fetchVerifiedAsset(assets, "tool.wasm", null), bytes);
  assert.deepEqual(progress[0], { path: "tool.wasm", loaded: 0, total: 4, cached: false });
  assert.equal(progress.at(-1).loaded, 4);
  progress.length = 0;
  assert.deepEqual(await loader.fetchVerifiedAsset(assets, "tool.wasm", {
    match: async () => new Response(bytes),
  }), bytes);
  assert.equal(requests, 1);
  assert.deepEqual(progress, [{ path: "tool.wasm", loaded: 4, total: 4, cached: true }]);
});

test("download progress does not bypass missing-file and integrity failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(Uint8Array.of(0)));
  const loader = createVerifiedAssetLoader({ baseURL: new URL("https://example.test/"), cacheName: "test" });
  await assert.rejects(loader.fetchVerifiedAsset(new Map(), "missing", null), /missing from manifest/);
  await assert.rejects(loader.fetchVerifiedAsset(new Map([["bad", { size: 2, sha256: digest }]]), "bad", null), /size mismatch/);
});
const legacyAsset = {
  path: "yosys.wasm",
  size: 10,
  sha256: digest,
};

test("manifest validation accepts legacy and zstd entries", () => {
  const assets = verifyManifest({
    format_version: 1,
    assets: [
      legacyAsset,
      {
        path: "chipdb/chipdb-GW1NZ-1.bin",
        size: 20,
        sha256: digest,
        encoding: "zstd",
        compressed_size: 12,
        compressed_sha256: "b".repeat(64),
      },
    ],
  });

  assert.equal(assets.get("yosys.wasm").encoding, undefined);
  assert.equal(assets.get("chipdb/chipdb-GW1NZ-1.bin").encoding, "zstd");
});

test("manifest validation rejects unknown encodings and incomplete zstd metadata", () => {
  for (const entry of [
    { ...legacyAsset, encoding: "gzip" },
    { ...legacyAsset, encoding: "zstd", compressed_size: 12 },
    {
      ...legacyAsset,
      encoding: "zstd",
      compressed_size: 0,
      compressed_sha256: digest,
    },
    {
      ...legacyAsset,
      encoding: "zstd",
      compressed_size: 12,
      compressed_sha256: "invalid",
    },
  ]) {
    assert.throws(
      () => verifyManifest({ format_version: 1, assets: [entry] }),
      /Synthesis asset manifest contains an invalid entry/,
    );
  }
});

test("manifest validation rejects unsafe and repeated paths", () => {
  assert.throws(
    () =>
      verifyManifest({
        format_version: 1,
        assets: [{ ...legacyAsset, path: "../yosys.wasm" }],
      }),
    /Synthesis asset manifest contains an invalid entry/,
  );
  assert.throws(
    () =>
      verifyManifest({
        format_version: 1,
        assets: [legacyAsset, legacyAsset],
      }),
    /Synthesis asset manifest repeats yosys\.wasm/,
  );
});

test("manifest validation supports pack-specific error labels", () => {
  assert.throws(
    () => verifyManifest({ format_version: 2, assets: [] }, "Pack asset"),
    /Pack asset manifest is invalid/,
  );
  assert.throws(
    () =>
      verifyManifest(
        { format_version: 1, assets: [{ ...legacyAsset, encoding: "gzip" }] },
        "Pack asset",
      ),
    /Pack asset manifest contains an invalid entry/,
  );
});

test("verified asset loader derives cache keys from its base URL", () => {
  const loader = createVerifiedAssetLoader({
    baseURL: new URL("https://example.test/pack/"),
    cacheName: "gogo-fpga-pack-v1",
    label: "Pack asset",
  });
  assert.equal(
    loader.cacheKey("pyodide/pyodide.asm.wasm", digest).href,
    `https://example.test/pack/pyodide/pyodide.asm.wasm?sha256=${digest}`,
  );
});
