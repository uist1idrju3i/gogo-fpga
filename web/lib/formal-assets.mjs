import { createVerifiedAssetLoader, safePath } from "./verified-assets.mjs";

const encoder = new TextEncoder();
const MAX_PYTHON_BYTES = 64 * 1024 * 1024;

async function readLimited(response, limit, signal) {
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    signal.throwIfAborted();
    if (bytes.length > limit) throw new Error("Formal asset exceeds its size limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Formal asset exceeds its size limit");
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function loadWithin(work, { signal, timeoutMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new TypeError("Invalid formal asset timeout");
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", cancel, { once: true });
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(
    new DOMException("形式検証の資材取得が時間上限に達しました", "TimeoutError"),
  ), timeoutMs);
  try {
    return await Promise.race([work(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createFormalAssetLoader({
  synthURL = new URL("../synth/", import.meta.url),
  formalURL = new URL("../formal/", import.meta.url),
  fetchImpl = (...args) => fetch(...args),
  synthLoader = null,
} = {}) {
  const synth = synthLoader ?? createVerifiedAssetLoader({
    baseURL: synthURL,
    cacheName: "gogo-fpga-synth-v1",
    label: "Synthesis asset",
  });

  let cachedYosys = null;
  let cachedPython = null;

  async function loadYosys(signal) {
    if (cachedYosys) return cachedYosys;
    const manifest = await synth.loadManifest({ signal });
    const cache = await synth.openCache();
    const [wasm, share] = await Promise.all([
      synth.fetchVerifiedAsset(manifest, "yosys.wasm", cache, { signal }),
      synth.fetchVerifiedAsset(manifest, "yosys-share.tar", cache, { signal }),
    ]);
    await synth.pruneCache?.(cache, manifest);
    const result = {
      wasm,
      sha256: await sha256Hex(wasm),
      share,
      shareSha256: await sha256Hex(share),
    };
    signal.throwIfAborted();
    cachedYosys = result;
    return result;
  }

  async function loadPythonBundle(signal) {
    if (cachedPython) return cachedPython;
    const options = { signal, cache: "no-cache" };
    const manifestResponse = await fetchImpl(new URL("python/manifest.json", formalURL), options);
    if (!manifestResponse?.ok) return null;
    if (!/^application\/(?:json|[\w.-]+\+json)(?:\s*;|$)/i.test(manifestResponse.headers.get("Content-Type") ?? "")) return null;
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(
      await readLimited(manifestResponse, 256 * 1024, signal),
    ));
    if (manifest?.format_version !== 1 || !Array.isArray(manifest.assets) ||
        manifest.assets.length === 0 || manifest.assets.length > 256) {
      return null;
    }
    const entries = new Map();
    let total = 0;
    for (const asset of manifest.assets) {
      if (!safePath(asset?.path) || entries.has(asset.path) || !Number.isSafeInteger(asset?.size) ||
          asset.size <= 0 || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) return null;
      total += asset.size;
      if (total > MAX_PYTHON_BYTES) return null;
      entries.set(asset.path, asset);
    }
    const sources = [];
    for (const [path, asset] of entries) {
      signal.throwIfAborted();
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const response = await fetchImpl(new URL(`python/${encodedPath}`, formalURL), options);
      if (!response?.ok) return null;
      const bytes = await readLimited(response, asset.size, signal);
      if (bytes.length !== asset.size || await sha256Hex(bytes) !== asset.sha256) return null;
      sources.push({ path, bytes });
    }
    signal.throwIfAborted();
    cachedPython = { sources, manifest };
    return cachedPython;
  }

  async function optional(work, signal) {
    try {
      return await work(signal);
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  async function loadAssets(includePython, options) {
    return loadWithin(async (signal) => {
      const [yosys, python] = await Promise.all([
        optional(loadYosys, signal),
        includePython ? optional(loadPythonBundle, signal) : null,
      ]);
      return { yosys, sources: python?.sources ?? [], manifest: python?.manifest ?? null, solvers: {} };
    }, options);
  }
  return Object.freeze({
    loadYosys: (options) => loadWithin((signal) => optional(loadYosys, signal), options),
    loadPython: (options) => loadWithin((signal) => optional(loadPythonBundle, signal), options),
    loadAll: (options) => loadAssets(true, options),
    loadForEngine(engine, options) {
      if (engine !== "yosys-sat" && engine !== "smtbmc") {
        throw new TypeError("Unsupported formal asset engine");
      }
      return loadAssets(engine === "smtbmc", options);
    },
  });
}

export async function snapshotHash(project, files) {
  const encoder = new TextEncoder();
  const entries = (project?.files ?? [])
    .map(({ path }) => path)
    .filter((path) => files.has(path))
    .sort();
  const parts = [JSON.stringify(project ?? null)];
  for (const path of entries) {
    const content = files.get(path);
    const bytes = content instanceof Uint8Array ? content : encoder.encode(String(content ?? ""));
    parts.push(path, bytes.length, [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join(""));
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(parts.join("\n")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
