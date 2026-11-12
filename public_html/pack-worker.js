import { getBoard } from "./lib/boards.mjs";
import {
  prepareGowinPackRuntime,
  runGowinPack,
} from "./lib/gowin-pack.mjs";
import { releaseDecoders } from "./lib/decompress.mjs";
import { createVerifiedAssetLoader } from "./lib/verified-assets.mjs";

const indexURL = new URL("./pack/pyodide/", import.meta.url).href;
const packURL = new URL("./pack/", import.meta.url);
const packCacheName = "gogo-fpga-pack-v1";
const packAssetsLoader = createVerifiedAssetLoader({
  baseURL: packURL,
  cacheName: packCacheName,
  label: "Pack asset",
  cacheRaw: true,
});
const apyculaWheelURL = new URL(
  "./pack/wheels/apycula-0.35-py3-none-any.whl",
  import.meta.url,
).href;
let loadPyodidePromise;
let packAssetsPromise;
let packFetchInstalled = false;

async function getLoadPyodide() {
  if (!loadPyodidePromise) {
    loadPyodidePromise = import(new URL("./pack/pyodide/pyodide.mjs", import.meta.url))
      .then((module) => module.loadPyodide);
    loadPyodidePromise.catch(() => {
      loadPyodidePromise = null;
    });
  }
  return loadPyodidePromise;
}

function packContentType(path) {
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".zip") || path.endsWith(".whl")) return "application/zip";
  return "application/octet-stream";
}

function installPackFetch(assets, cache) {
  if (packFetchInstalled) return;
  const assetPaths = new Map(
    [...assets.keys()]
      .filter((path) => !path.endsWith(".mjs"))
      .map((path) => [new URL(path, packURL).href, path]),
  );
  const originalFetch = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    let url;
    try {
      url = input instanceof Request
        ? input.url
        : new URL(input, self.location.href).href;
    } catch {
      return originalFetch(input, init);
    }
    const path = assetPaths.get(url);
    if (!path) return originalFetch(input, init);
    const bytes = await packAssetsLoader.fetchVerifiedAsset(assets, path, cache);
    return new Response(bytes, {
      headers: { "Content-Type": packContentType(path) },
    });
  };
  packFetchInstalled = true;
}

async function getPackAssets() {
  if (!packAssetsPromise) {
    packAssetsPromise = (async () => {
      const assets = await packAssetsLoader.loadManifest();
      const cache = await packAssetsLoader.openCache();
      const lockBytes = await packAssetsLoader.fetchVerifiedAsset(
        assets,
        "pyodide/pyodide-lock.json",
        cache,
      );
      const lockFileContents = JSON.parse(new TextDecoder().decode(lockBytes));
      await packAssetsLoader.fetchVerifiedAsset(
        assets,
        "pyodide/pyodide.asm.wasm",
        cache,
      );
      installPackFetch(assets, cache);
      return { assets, cache, lockFileContents };
    })();
    packAssetsPromise.catch(() => {
      packAssetsPromise = null;
    });
  }
  return packAssetsPromise;
}

function sendLog(stream, text) {
  if (text) self.postMessage({ type: "log", tool: "gowin_pack", stream, text });
}

self.addEventListener("message", async ({ data }) => {
  if (data?.type !== "pack") {
    self.postMessage({
      type: "error",
      stage: "pack",
      message: "Unsupported pack worker message",
    });
    return;
  }

  self.postMessage({ type: "stage", stage: "pack" });
  try {
    const started = performance.now();
    const board = getBoard(data.board);
    if (!board) throw new Error(`Unknown board: ${data.board}`);
    const packAssets = await getPackAssets();
    const loadPyodide = await getLoadPyodide();
    try {
      await prepareGowinPackRuntime({
        loadPyodide,
        indexURL,
        apyculaWheelURL,
        lockFileContents: packAssets.lockFileContents,
      });
    } finally {
      releaseDecoders();
    }
    await packAssetsLoader.pruneCache(packAssets.cache, packAssets.assets);
    const result = await runGowinPack({
      loadPyodide,
      indexURL,
      apyculaWheelURL,
      lockFileContents: packAssets.lockFileContents,
      netlistJson: new Uint8Array(data.netlistJson),
      device: board.packDevice,
    });
    sendLog("stdout", result.stdout);
    sendLog("stderr", result.stderr);
    const bytes = result.fs;
    self.postMessage(
      {
        type: "done",
        files: [{ path: "build/top.fs", bytes }],
        timings: { pack: performance.now() - started },
        memoryBytes: { gowin_pack: result.memoryBytes },
      },
      [bytes.buffer],
    );
  } catch (error) {
    sendLog("stdout", error?.stdout ?? "");
    sendLog("stderr", error?.stderr ?? "");
    self.postMessage({
      type: "error",
      stage: "pack",
      message: String(error?.message ?? error),
    });
  }
});
