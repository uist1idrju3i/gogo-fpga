import { parentPort } from "node:worker_threads";
import { loadPyodide } from "pyodide";
import { runFormalPythonJob } from "../../web/lib/formal-python-job.mjs";

globalThis.crossOriginIsolated = true;
parentPort.once("message", async data => {
  const post = message => parentPort.postMessage(message);
  const deterministicLoad = options => loadPyodide({ ...options, env: { PYTHONHASHSEED: "0" } });
  post(await runFormalPythonJob(data, deterministicLoad, post));
});
