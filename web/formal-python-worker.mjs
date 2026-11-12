import { runFormalPythonJob } from "./lib/formal-python-job.mjs";

let started = false;
globalThis.addEventListener("message", async ({ data }) => {
  if (started) return;
  started = true;
  const { loadPyodide } = await import("./pack/pyodide/pyodide.mjs");
  globalThis.postMessage(await runFormalPythonJob(data, loadPyodide, message => globalThis.postMessage(message)));
});
