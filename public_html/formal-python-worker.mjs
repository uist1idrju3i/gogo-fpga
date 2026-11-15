import { runFormalPythonJob } from "./lib/formal-python-job.mjs";
import { createFormalPyodideLoader } from "./lib/formal-pyodide.mjs";

let started = false;
globalThis.addEventListener("message", async ({ data }) => {
  if (started) return;
  started = true;
  try {
    const { loadPyodide } = await import("./pack/pyodide/pyodide.mjs");
    const load = createFormalPyodideLoader({ loadPyodide });
    globalThis.postMessage(await runFormalPythonJob(data, load, message => globalThis.postMessage(message)));
  } catch (error) {
    globalThis.postMessage({ type: "failure", jobId: data.jobId, status: "setup-error", error: String(error.message).slice(0, 1024) });
  }
});
