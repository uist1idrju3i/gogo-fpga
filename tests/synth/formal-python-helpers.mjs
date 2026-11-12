import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import path from "node:path";

export function nodeFormalWorker(url = new URL("../web/formal-python-node-worker.mjs", import.meta.url)) {
  const worker = new Worker(url, { execArgv: [] });
  const wrappers = new Map();
  worker.on("error", () => {});
  return {
    postMessage: (...args) => worker.postMessage(...args),
    terminate: () => worker.terminate(),
    addEventListener(type, listener) {
      const wrapped = type === "message" ? data => listener({ data }) : error => listener({ message: error.message });
      wrappers.set(listener, wrapped); worker.on(type, wrapped);
    },
    removeEventListener(type, listener) { worker.off(type, wrappers.get(listener)); wrappers.delete(listener); },
  };
}

export function nodeFormalWasiWorker() {
  return nodeFormalWorker(new URL("../web/formal-wasi-node-worker.mjs", import.meta.url));
}

export function readFormalSources(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json")));
  const sources = manifest.assets.map(asset => ({ path: asset.path, bytes: new Uint8Array(readFileSync(path.join(directory, asset.path))) }));
  return { manifest, sources };
}
