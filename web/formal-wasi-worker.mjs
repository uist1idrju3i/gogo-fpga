import { runFormalWasiJob } from "./lib/formal-wasi-job.mjs";

let started = false;
globalThis.addEventListener("message", async ({ data }) => {
  if (started) return;
  started = true;
  globalThis.postMessage(await runFormalWasiJob(data));
});
