import assert from "node:assert/strict";
import test from "node:test";

import { createFormalAssetLoader, snapshotHash } from "../../web/lib/formal-assets.mjs";

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function response(bytes, { ok = true, json } = {}) {
  return {
    ok,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
    async json() {
      return json;
    },
  };
}

function fakeSynthLoader(files) {
  return {
    async loadManifest() {
      return new Map(Object.entries(files).map(([path, bytes]) => [path, { path, size: bytes.length, sha256: "0".repeat(64) }]));
    },
    async openCache() {
      return null;
    },
    async fetchVerifiedAsset(_manifest, path) {
      const bytes = files[path];
      if (!bytes) throw new Error(`missing ${path}`);
      return bytes;
    },
    async pruneCache() {},
  };
}

test("python bundle is absent when the manifest cannot be fetched", async () => {
  const loader = createFormalAssetLoader({
    fetchImpl: async () => response(new Uint8Array(), { ok: false }),
    synthLoader: fakeSynthLoader({}),
  });
  assert.equal(await loader.loadPython(), null);
});

test("python bundle loads hash-verified sources", async () => {
  const encoder = new TextEncoder();
  const files = {
    "sby.py": encoder.encode("print('sby')\n"),
    "click/__init__.py": encoder.encode("# click\n"),
  };
  const assets = [];
  for (const [path, bytes] of Object.entries(files)) {
    assets.push({ path, size: bytes.length, sha256: await sha256Hex(bytes) });
  }
  const manifest = { format_version: 1, assets };
  const manifestBytes = encoder.encode(JSON.stringify(manifest));
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.endsWith("manifest.json")) return response(manifestBytes, { json: manifest });
    const path = href.split("/python/")[1];
    const bytes = files[path];
    return bytes ? response(bytes) : response(new Uint8Array(), { ok: false });
  };
  const loader = createFormalAssetLoader({ fetchImpl, synthLoader: fakeSynthLoader({}) });
  const python = await loader.loadPython();
  assert.equal(python.sources.length, 2);
  assert.deepEqual(python.sources.map(({ path }) => path).sort(), ["click/__init__.py", "sby.py"]);
  assert.equal(python.manifest.format_version, 1);
});

test("python bundle rejects hash mismatches and unsafe paths", async () => {
  const encoder = new TextEncoder();
  const badHash = [{ path: "sby.py", size: 3, sha256: "0".repeat(64) }];
  const unsafe = [{ path: "../escape.py", size: 3, sha256: await sha256Hex(encoder.encode("bad")) }];
  for (const assets of [badHash, unsafe]) {
    const manifest = { format_version: 1, assets };
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const loader = createFormalAssetLoader({
      fetchImpl: async (url) => String(url).endsWith("manifest.json")
        ? response(manifestBytes, { json: manifest })
        : response(encoder.encode("bad")),
      synthLoader: fakeSynthLoader({}),
    });
    assert.equal(await loader.loadPython(), null);
  }
});

test("loadAll combines yosys assets with an absent python bundle", async () => {
  const wasm = new Uint8Array([1, 2, 3]);
  const share = new Uint8Array([4, 5, 6]);
  const loader = createFormalAssetLoader({
    fetchImpl: async () => response(new Uint8Array(), { ok: false }),
    synthLoader: fakeSynthLoader({ "yosys.wasm": wasm, "yosys-share.tar": share }),
  });
  const assets = await loader.loadAll();
  assert.deepEqual(assets.yosys.wasm, wasm);
  assert.match(assets.yosys.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(assets.yosys.share, share);
  assert.deepEqual(assets.sources, []);
  assert.equal(assets.manifest, null);
  assert.deepEqual(assets.solvers, {});
});

test("snapshotHash is stable and sensitive to content", async () => {
  const files = new Map([
    ["src/top.v", "module top; endmodule\n"],
    ["constraints/board.cst", "PIN led 1\n"],
  ]);
  const project = { name: "demo", files: [{ path: "src/top.v" }, { path: "constraints/board.cst" }] };
  const first = await snapshotHash(project, files);
  const second = await snapshotHash(project, new Map(files));
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
  const changed = new Map(files);
  changed.set("src/top.v", "module top; reg a; endmodule\n");
  assert.notEqual(await snapshotHash(project, changed), first);
});
