import { createVerifiedAssetLoader, safePath } from "./verified-assets.mjs";

const encoder = new TextEncoder();

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

  async function loadYosys() {
    const manifest = await synth.loadManifest();
    const cache = await synth.openCache();
    const [wasm, share] = await Promise.all([
      synth.fetchVerifiedAsset(manifest, "yosys.wasm", cache),
      synth.fetchVerifiedAsset(manifest, "yosys-share.tar", cache),
    ]);
    await synth.pruneCache?.(cache, manifest);
    return {
      wasm,
      sha256: await sha256Hex(wasm),
      share,
      shareSha256: await sha256Hex(share),
    };
  }

  async function loadPythonBundle() {
    let manifestResponse;
    try {
      manifestResponse = await fetchImpl(new URL("python/manifest.json", formalURL));
    } catch {
      return null;
    }
    if (!manifestResponse?.ok) return null;
    const manifest = await manifestResponse.json();
    if (manifest?.format_version !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length > 256) {
      return null;
    }
    const entries = new Map();
    for (const asset of manifest.assets) {
      if (!safePath(asset?.path) || entries.has(asset.path) || asset?.size <= 0 || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) return null;
      entries.set(asset.path, asset);
    }
    const sources = [];
    for (const [path, asset] of entries) {
      let response;
      try {
        response = await fetchImpl(new URL(`python/${path}`, formalURL));
      } catch {
        return null;
      }
      if (!response?.ok) return null;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== asset.size || await sha256Hex(bytes) !== asset.sha256) return null;
      sources.push({ path, bytes });
    }
    return { sources, manifest };
  }

  let pythonPromise = null;
  function loadPython() {
    pythonPromise ??= loadPythonBundle();
    return pythonPromise;
  }

  let yosysPromise = null;
  function loadYosysCached() {
    yosysPromise ??= loadYosys().catch(() => null);
    return yosysPromise;
  }

  return Object.freeze({
    loadYosys: loadYosysCached,
    loadPython,
    async loadAll() {
      const [yosys, python] = await Promise.all([loadYosysCached(), loadPython()]);
      return {
        yosys,
        sources: python?.sources ?? [],
        manifest: python?.manifest ?? null,
        solvers: {},
      };
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
