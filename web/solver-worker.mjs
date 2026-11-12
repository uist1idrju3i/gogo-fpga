import { runSolverJob } from "./lib/solver-job.mjs";

let started = false;
globalThis.addEventListener("message", async ({ data }) => {
  if (started) return;
  started = true;
  const result = await runSolverJob(data);
  globalThis.postMessage(result);
});
