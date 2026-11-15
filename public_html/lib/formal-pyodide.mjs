import { createVerifiedAssetLoader } from "./verified-assets.mjs";

export function createFormalPyodideLoader({
  baseURL = new URL("../pack/", import.meta.url),
  loadPyodide,
  scope = globalThis,
  loader = createVerifiedAssetLoader({ baseURL, cacheName: "gogo-fpga-pack-v1", label: "Formal Python runtime", cacheRaw: true }),
} = {}) {
  let prepared = null;
  async function prepare() {
    const assets = await loader.loadManifest();
    const cache = await loader.openCache();
    const paths = ["pyodide/pyodide.asm.wasm", "pyodide/python_stdlib.zip", "pyodide/pyodide-lock.json"];
    const urls = new Map(paths.map(path => [new URL(path, baseURL).href, path]));
    const lock = await loader.fetchVerifiedAsset(assets, paths[2], cache);
    const lockFileContents = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lock));
    for (const path of paths) {
      if (!assets.has(path)) throw new Error(`Missing formal Python runtime asset: ${path}`);
    }
    const originalFetch = scope.fetch.bind(scope);
    scope.fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : new URL(input, baseURL).href;
      const path = urls.get(url);
      if (!path) return originalFetch(input, init);
      const bytes = await loader.fetchVerifiedAsset(assets, path, cache);
      return new Response(bytes, { headers: { "Content-Type": path.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
    };
    return { indexURL: new URL("pyodide/", baseURL).href, lockFileContents };
  }
  return async options => {
    if (!prepared) {
      prepared = prepare();
      prepared.catch(() => { prepared = null; });
    }
    return loadPyodide({ ...options, ...await prepared });
  };
}
