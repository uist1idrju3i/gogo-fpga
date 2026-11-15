// Run the browser simulation worker unchanged, adapting Node's messaging and URL base.
import { parentPort, workerData } from "node:worker_threads";

globalThis.self = {
  addEventListener(type, listener) { parentPort.on(type, data => listener({ data })); },
  postMessage(data) { parentPort.postMessage(data); },
};
const network = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input);
  return network(url.protocol === "file:" && /\/web\/iverilog\/[a-z]+\.wasm$/.test(url.pathname)
    ? new URL(`iverilog/${url.pathname.split("/").at(-1)}`, workerData.baseURL) : input, options);
};
await import("../../web/sim-worker.js");
