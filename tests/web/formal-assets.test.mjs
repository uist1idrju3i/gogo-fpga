import assert from "node:assert/strict";
import test from "node:test";

import { createFormalAssetLoader, snapshotHash } from "../../web/lib/formal-assets.mjs";

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function response(bytes, { ok = true, json } = {}) {
  return new Response(bytes, { status: ok ? 200 : 404,
    headers: { "Content-Type": json ? "application/json" : "application/octet-stream" } });
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

const yosysFiles = { "yosys.wasm": new Uint8Array([1, 2, 3]), "yosys-share.tar": new Uint8Array([4, 5]) };

async function pythonFixture(path = "sby.py") {
  const bytes = new TextEncoder().encode("print('sby')\n");
  const manifest = { format_version: 1, assets: [{ path, size: bytes.length, sha256: await sha256Hex(bytes) }] };
  return { bytes, manifest, fetch: async (url) => String(url).endsWith("manifest.json")
    ? Response.json(manifest) : new Response(bytes) };
}

test("SAT loads only Yosys even if the Python server never responds", async () => {
  let pythonRequests = 0;
  const loader = createFormalAssetLoader({
    synthLoader: fakeSynthLoader(yosysFiles),
    fetchImpl: () => { pythonRequests++; return new Promise(() => {}); },
  });
  const assets = await loader.loadForEngine("yosys-sat", { timeoutMs: 1000 });
  assert.deepEqual(assets.yosys.wasm, yosysFiles["yosys.wasm"]);
  assert.deepEqual(assets.sources, []);
  assert.equal(assets.manifest, null);
  assert.equal(pythonRequests, 0);
  assert.throws(() => loader.loadForEngine("unknown"), /Unsupported/);
});

for (const [name, fetchImpl] of [
  ["Pages 200 HTML", async () => new Response("<!doctype html><html>app</html>", { headers: { "Content-Type": "text/html" } })],
  ["HTML mislabeled JSON", async () => new Response("<!doctype html>", { headers: { "Content-Type": "application/json" } })],
  ["malformed JSON", async () => new Response('{"format_version":', { headers: { "Content-Type": "application/json" } })],
  ["404", async () => new Response("Not found", { status: 404 })],
  ["network failure", async () => { throw new TypeError("network disconnected"); }],
]) {
  test(`${name} leaves Python unavailable without discarding verified Yosys`, async () => {
    const loader = createFormalAssetLoader({ synthLoader: fakeSynthLoader(yosysFiles), fetchImpl });
    const assets = await loader.loadAll();
    assert.deepEqual(assets.yosys.wasm, yosysFiles["yosys.wasm"]);
    assert.equal(assets.manifest, null);
    assert.deepEqual(assets.sources, []);
    assert.deepEqual(assets.solvers, {});
  });
}

test("failed Python and Yosys acquisitions retry; only successful verified assets are reused", async () => {
  const fixture = await pythonFixture();
  let pythonCalls = 0;
  let yosysCalls = 0;
  const synth = fakeSynthLoader(yosysFiles);
  const loader = createFormalAssetLoader({
    synthLoader: { ...synth, async loadManifest() {
      if (++yosysCalls === 1) throw new Error("offline");
      return synth.loadManifest();
    } },
    fetchImpl: async (url) => ++pythonCalls === 1 ? new Response("fallback") : fixture.fetch(url),
  });
  const missing = await loader.loadAll();
  assert.equal(missing.yosys, null);
  assert.equal(missing.manifest, null);
  const retried = await loader.loadAll();
  assert.deepEqual(retried.yosys.wasm, yosysFiles["yosys.wasm"]);
  assert.equal(retried.sources.length, 1);
  await loader.loadAll();
  assert.equal(yosysCalls, 2);
  assert.equal(pythonCalls, 3);
});

test("Python stream interruption and oversized payloads are discarded and can be retried", async () => {
  const fixture = await pythonFixture();
  for (const failure of ["interrupted", "oversized", "truncated"]) {
    let fail = true;
    let cancelled = false;
    const loader = createFormalAssetLoader({
      fetchImpl: async (url) => {
        if (String(url).endsWith("manifest.json")) return Response.json(fixture.manifest);
        if (!fail) return new Response(fixture.bytes);
        if (failure === "truncated") return new Response(fixture.bytes.slice(0, -1));
        return new Response(new ReadableStream({
          start(controller) {
            if (failure === "interrupted") controller.error(new Error("connection reset"));
            else controller.enqueue(new Uint8Array(fixture.bytes.length + 1));
          },
          cancel() { cancelled = true; },
        }));
      },
    });
    assert.equal(await loader.loadPython(), null, failure);
    if (failure === "oversized") assert.equal(cancelled, true);
    fail = false;
    assert.equal((await loader.loadPython()).sources.length, 1, failure);
  }
});

test("Python manifest limits reject invalid sizes, duplicate paths and excessive allocation before fetching assets", async () => {
  const fixture = await pythonFixture();
  const entry = fixture.manifest.assets[0];
  for (const assets of [[], [{ ...entry, size: 1.5 }], [{ ...entry, size: "12" }],
    [{ ...entry, size: 65 * 1024 * 1024 }], [entry, entry], Array(257).fill(entry)]) {
    let requests = 0;
    const loader = createFormalAssetLoader({ fetchImpl: async () => {
      requests++;
      return Response.json({ format_version: 1, assets });
    } });
    assert.equal(await loader.loadPython(), null);
    assert.equal(requests, 1);
  }
});

test("Python source paths are URL encoded while the verified source name is preserved", async () => {
  const fixture = await pythonFixture("dir/a?#%.py");
  const urls = [];
  const loader = createFormalAssetLoader({ fetchImpl: async (url) => {
    urls.push(String(url));
    return fixture.fetch(url);
  } });
  const bundle = await loader.loadPython();
  assert.equal(bundle.sources[0].path, "dir/a?#%.py");
  assert.match(urls[1], /\/python\/dir\/a%3F%23%25\.py$/);
});

test("abort and timeout interrupt acquisition even if fetch ignores the signal, then allow retry", async () => {
  for (const mode of ["abort", "timeout"]) {
    const fixture = await pythonFixture();
    let pending = true;
    let fetchSignal;
    const loader = createFormalAssetLoader({ fetchImpl: async (url, options) => {
      fetchSignal = options.signal;
      return pending ? new Promise(() => {}) : fixture.fetch(url);
    } });
    const controller = new AbortController();
    const acquisition = loader.loadPython({ signal: controller.signal, timeoutMs: mode === "timeout" ? 10 : 1000 });
    if (mode === "abort") controller.abort();
    await assert.rejects(acquisition, { name: mode === "abort" ? "AbortError" : "TimeoutError" });
    assert.equal(fetchSignal.aborted, true);
    pending = false;
    assert.equal((await loader.loadPython()).sources.length, 1);
  }
});

test("Yosys acquisition receives the abort signal and a late cancelled load cannot populate the cache", async () => {
  let release;
  let first = true;
  let observedSignal;
  const synth = fakeSynthLoader(yosysFiles);
  const loader = createFormalAssetLoader({ synthLoader: {
    ...synth,
    async loadManifest({ signal }) {
      observedSignal = signal;
      if (first) { first = false; await new Promise((resolve) => { release = resolve; }); }
      return synth.loadManifest();
    },
    async fetchVerifiedAsset(manifest, path, cache, { signal }) {
      assert.ok(signal instanceof AbortSignal);
      return synth.fetchVerifiedAsset(manifest, path, cache);
    },
  } });
  const controller = new AbortController();
  const pending = loader.loadForEngine("yosys-sat", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(observedSignal.aborted, true);
  const next = await loader.loadForEngine("yosys-sat");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await loader.loadForEngine("yosys-sat")).yosys, next.yosys);
});

test("a pre-aborted request performs no fetches", async () => {
  const controller = new AbortController();
  controller.abort();
  const loader = createFormalAssetLoader({ fetchImpl: () => assert.fail("unexpected fetch") });
  await assert.rejects(loader.loadPython({ signal: controller.signal }), { name: "AbortError" });
});
