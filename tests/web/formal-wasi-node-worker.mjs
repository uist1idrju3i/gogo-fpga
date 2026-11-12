import { parentPort } from "node:worker_threads";
import { runFormalWasiJob } from "../../web/lib/formal-wasi-job.mjs";

globalThis.crossOriginIsolated = true;
parentPort.once("message", async data => parentPort.postMessage(await runFormalWasiJob(data)));
