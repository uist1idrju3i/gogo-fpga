import { decompress } from "./decompress.mjs";

function labelText(label) {
  return label.toLowerCase();
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safePath(path) {
  return typeof path === "string" &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every(
      (part) => part.length > 0 && part !== "." && part !== "..",
    );
}

export function verifyManifest(manifest, label = "Synthesis asset") {
  if (
    manifest?.format_version !== 1 ||
    !Array.isArray(manifest.assets)
  ) {
    throw new Error(`${label} manifest is invalid`);
  }
  const assets = new Map();
  for (const asset of manifest.assets) {
    if (
      !safePath(asset?.path) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !/^[0-9a-f]{64}$/.test(asset.sha256) ||
      (asset.encoding !== undefined && asset.encoding !== "zstd") ||
      (asset.encoding === "zstd" &&
        (!Number.isSafeInteger(asset.compressed_size) ||
          asset.compressed_size <= 0 ||
          !/^[0-9a-f]{64}$/.test(asset.compressed_sha256)))
    ) {
      throw new Error(`${label} manifest contains an invalid entry`);
    }
    if (assets.has(asset.path)) {
      throw new Error(`${label} manifest repeats ${asset.path}`);
    }
    assets.set(asset.path, asset);
  }
  return assets;
}

export function createVerifiedAssetLoader({
  baseURL,
  cacheName,
  label = "Synthesis asset",
  cacheRaw = false,
}) {
  if (!(baseURL instanceof URL)) {
    throw new TypeError("baseURL must be a URL");
  }
  if (typeof cacheName !== "string" || cacheName.length === 0) {
    throw new TypeError("cacheName must be a non-empty string");
  }

  const fetchAsset = globalThis.fetch.bind(globalThis);
  const lowerLabel = labelText(label);
  const cacheKey = (path, sha256) =>
    new URL(`${path}?sha256=${sha256}`, baseURL);
  const shouldCache = (asset) => asset.encoding === "zstd" || cacheRaw;

  async function loadManifest() {
    const response = await fetchAsset(new URL("manifest.json", baseURL), {
      cache: "no-cache",
    });
    if (!response.ok) {
      throw new Error(`Could not load ${lowerLabel} manifest (${response.status})`);
    }
    return verifyManifest(await response.json(), label);
  }

  async function openCache() {
    try {
      if (!globalThis.caches?.open) {
        throw new Error("Cache Storage is unavailable");
      }
      return await globalThis.caches.open(cacheName);
    } catch (error) {
      console.warn(`Could not open ${lowerLabel} cache`, error);
      return null;
    }
  }

  async function verifyAssetBytes(bytes, metadata, path) {
    if (bytes.byteLength !== metadata.size) {
      throw new Error(
        `${label} size mismatch for ${path}: expected ${metadata.size}, received ${bytes.byteLength}`,
      );
    }
    const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
    if (digest !== metadata.sha256) {
      throw new Error(`${label} SHA-256 mismatch for ${path}`);
    }
    return bytes;
  }

  async function fetchVerifiedAsset(assets, path, cache) {
    const metadata = assets.get(path);
    if (!metadata) throw new Error(`${label} is missing from manifest: ${path}`);
    const key = cacheKey(path, metadata.sha256);
    if (shouldCache(metadata) && cache) {
      try {
        const cached = await cache.match(key);
        if (cached) {
          try {
            const bytes = new Uint8Array(await cached.arrayBuffer());
            return await verifyAssetBytes(bytes, metadata, path);
          } catch (error) {
            console.warn(`Discarding invalid cached ${lowerLabel} ${path}`, error);
            await cache.delete(key).catch((deleteError) => {
              console.warn(`Could not delete cached ${lowerLabel} ${path}`, deleteError);
            });
          }
        }
      } catch (error) {
        console.warn(`Could not read cached ${lowerLabel} ${path}`, error);
      }
    }

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      metadata.encoding === "zstd" ? `${encodedPath}.zst` : encodedPath,
      baseURL,
    );
    const response = await fetchAsset(url, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Could not load ${lowerLabel} ${path} (${response.status})`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    let output = bytes;
    if (metadata.encoding === "zstd") {
      if (bytes.byteLength !== metadata.compressed_size) {
        throw new Error(
          `${label} compressed size mismatch for ${path}: expected ${metadata.compressed_size}, received ${bytes.byteLength}`,
        );
      }
      const compressedDigest = hex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      );
      if (compressedDigest !== metadata.compressed_sha256) {
        throw new Error(`${label} compressed SHA-256 mismatch for ${path}`);
      }
      output = await decompress("zstd", bytes, metadata.size);
    }
    await verifyAssetBytes(output, metadata, path);
    if (shouldCache(metadata) && cache) {
      try {
        await cache.put(
          key,
          new Response(output, {
            headers: { "Content-Type": "application/octet-stream" },
          }),
        );
      } catch (error) {
        console.warn(`Could not cache ${lowerLabel} ${path}`, error);
      }
    }
    return output;
  }

  async function pruneCache(cache, assets) {
    if (!cache) return;
    const currentKeys = new Set(
      [...assets.values()]
        .filter(shouldCache)
        .map((asset) => cacheKey(asset.path, asset.sha256).href),
    );
    let requests;
    try {
      requests = await cache.keys();
    } catch (error) {
      console.warn(`Could not inspect ${lowerLabel} cache`, error);
      return;
    }
    for (const request of requests) {
      if (!currentKeys.has(request.url)) {
        try {
          await cache.delete(request);
        } catch (error) {
          console.warn(`Could not remove stale ${lowerLabel} cache entry`, error);
        }
      }
    }
  }

  return {
    cacheKey,
    fetchVerifiedAsset,
    loadManifest,
    openCache,
    pruneCache,
  };
}
