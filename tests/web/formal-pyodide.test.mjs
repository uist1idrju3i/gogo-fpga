import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFormalPyodideLoader } from "../../web/lib/formal-pyodide.mjs";
import { createVerifiedAssetLoader } from "../../web/lib/verified-assets.mjs";

const baseURL = new URL("https://example.test/pack/");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const files = {
  "pyodide/pyodide.asm.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  "pyodide/python_stdlib.zip": new TextEncoder().encode("stdlib fixture"),
  "pyodide/pyodide-lock.json": new TextEncoder().encode('{"info":{"version":"fixture"},"packages":{}}'),
};

function fixture(t, state = {}) {
  const requests = [];
  const assets = Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }));
  const compressed = execFileSync("zstd", ["-q", "-c"], { input: files[assets[0].path] });
  Object.assign(assets[0], { encoding: "zstd", compressed_size: compressed.length, compressed_sha256: hash(compressed) });
  t.mock.method(globalThis, "fetch", async input => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/manifest.json")) return state.offline ? new Response("offline", { status: 404 })
      : Response.json({ format_version: 1, assets });
    if (url.endsWith("/zstd-decoder.wasm")) return new Response(readFileSync(new URL("../../build/wasi/decoders/zstd-decoder.wasm", import.meta.url)));
    const path = url.slice(baseURL.href.length);
    if (path === "pyodide/pyodide.asm.wasm.zst") return new Response(state.corrupt ? new Uint8Array(compressed.length) : compressed);
    return files[path] ? new Response(files[path]) : new Response("missing", { status: 404 });
  });
  const loader = createVerifiedAssetLoader({ baseURL, cacheName: "formal-runtime-test" });
  const scope = { fetch: globalThis.fetch };
  return { scope, requests, loader: { ...loader, openCache: async () => null } };
}

test("formal Pyodide consumes verified compressed runtime and local stdlib with a verified lock", async t => {
  const options = { stdout() {}, stderr() {} };
  const { scope, requests, loader } = fixture(t);
  const load = createFormalPyodideLoader({ baseURL, scope, loader, loadPyodide: async config => {
    assert.equal(config.stdout, options.stdout);
    assert.equal(config.indexURL, new URL("pyodide/", baseURL).href);
    assert.deepEqual(config.lockFileContents, JSON.parse(new TextDecoder().decode(files["pyodide/pyodide-lock.json"])));
    for (const path of ["pyodide/pyodide.asm.wasm", "pyodide/python_stdlib.zip"]) {
      assert.deepEqual(new Uint8Array(await (await scope.fetch(new URL(path, baseURL))).arrayBuffer()), files[path]);
    }
    return "runtime";
  } });
  assert.equal(await load(options), "runtime");
  assert.ok(requests.some(url => url.endsWith(".wasm.zst")));
  assert.ok(!requests.includes(new URL("pyodide/pyodide.asm.wasm", baseURL).href));
  assert.equal((await scope.fetch(new URL("unrelated", baseURL))).status, 404);
});

test("formal runtime preparation retries a failed manifest without replacing fetch", async t => {
  const state = { offline: true };
  const { scope, loader } = fixture(t, state);
  const initialFetch = scope.fetch;
  const load = createFormalPyodideLoader({ baseURL, scope, loader, loadPyodide: async () => "runtime" });
  await assert.rejects(load({}), /manifest/);
  assert.equal(scope.fetch, initialFetch);
  state.offline = false;
  assert.equal(await load({}), "runtime");
});

test("formal runtime rejects a corrupt compressed binary before it reaches Pyodide", async t => {
  const { scope, loader } = fixture(t, { corrupt: true });
  const load = createFormalPyodideLoader({ baseURL, scope, loader, loadPyodide: async () => {
    await scope.fetch(new URL("pyodide/pyodide.asm.wasm", baseURL));
    assert.fail("Corrupt runtime must not execute");
  } });
  await assert.rejects(load({}), /compressed SHA-256 mismatch/);
});
