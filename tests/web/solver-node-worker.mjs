import { parentPort, workerData } from "node:worker_threads";

globalThis.crossOriginIsolated = true;
globalThis.addEventListener = (name, listener) => {
  if (name === "message") parentPort.on("message", data => listener({ data }));
};
globalThis.postMessage = data => {
  if (workerData.mode === "missing-termination") return;
  if (workerData.mode === "stale") parentPort.postMessage({ ...data, jobId: "old-job", result: { exitCode: 19, memoryBytes: 65536 } });
  parentPort.postMessage(data);
};

if (["crash", "missing", "invalid", "memory"].includes(workerData.mode)) {
  parentPort.on("message", data => {
    if (workerData.mode === "crash") throw new Error("Injected worker crash");
    if (workerData.mode === "missing") return;
    parentPort.postMessage({
      type: "exit", jobId: data.jobId, sha256: data.sha256,
      result: { exitCode: workerData.mode === "invalid" ? "0" : 0, memoryBytes: 512 * 1024 * 1024 + 65536 },
    });
  });
} else {
  await import("../../web/solver-worker.mjs");
}
