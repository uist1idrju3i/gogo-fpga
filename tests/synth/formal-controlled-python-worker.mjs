import { parentPort } from "node:worker_threads";
import { createHash } from "node:crypto";
import { loadPyodide } from "pyodide";
import { runFormalPythonJob } from "../../web/lib/formal-python-job.mjs";

globalThis.crossOriginIsolated = true;
parentPort.once("message", async data => {
  const { mode, root, flag } = data.testControl;
  const post = message => parentPort.postMessage(message);
  const observe = (event, detail = {}) => post({ type: "test-observation", jobId: data.jobId, event, ...detail });
  let injected = false;
  const digest = bytes => createHash("sha256").update(bytes).digest("hex");
  async function guardedLoad(options) {
    const py = await loadPyodide(options);
    py.runPython(`
import os, sys, subprocess, threading
def _native_boundary(name):
    def forbidden(*args, **kwargs):
        print("FORBIDDEN_NATIVE_BOUNDARY:" + name, file=sys.stderr)
        raise AssertionError("Forbidden native boundary: " + name)
    return forbidden
for _name in ("run", "Popen"):
    setattr(subprocess, _name, _native_boundary("subprocess." + _name))
threading.Thread.start = _native_boundary("threading.Thread.start")
for _name in ("pipe", "pipe2", "fork", "posix_spawn"):
    if hasattr(os, _name):
        setattr(os, _name, _native_boundary("os." + _name))
try:
    import resource
except ImportError:
    pass
else:
    raise AssertionError("Expected unavailable browser resource module")
os.environ["MAKEFLAGS"] = "--jobserver-auth=3,4 -j8"
`);
    observe("native-guards-installed", { resourceAvailable: false, inheritedMakeflags: "--jobserver-auth=3,4 -j8", pythonVersion: py.runPython("sys.version") });
    return {
      ...py,
      runPython(source) {
        const value = py.runPython(source);
        observe("environment-after-run", { makeflags: py.runPython('os.environ.get("MAKEFLAGS")') });
        if (root && injected && mode === "conflict-delta") {
          observe("conflict-root-preserved", { sha256: digest(py.FS.readFile("/work/result/model/design.json")) });
        }
        return value;
      },
      registerJsModule(name, host) {
        if (name !== "_formal_host") return py.registerJsModule(name, host);
        return py.registerJsModule(name, {
          ...host,
          pause(milliseconds) {
            if (root && mode === "crash" && Atomics.load(new Int32Array(flag), 0) === 1) {
              observe("root-crash", { exitCode: 17 });
              process.exit(17);
            }
            return host.pause(milliseconds);
          },
          spawn_process(args, cwd) {
            const child = host.spawn_process(args, cwd);
            return {
              ...child,
              take_delta() {
                const frame = child.take_delta();
                if (!root || injected || !["corrupt-delta", "conflict-delta"].includes(mode)) return frame;
                injected = true;
                if (mode === "corrupt-delta") {
                  const changed = new Uint8Array(frame);
                  changed[changed.length - 1] ^= 1;
                  observe("delta-corrupted", { bytes: frame.length, beforeSha256: digest(frame), afterSha256: digest(changed) });
                  return changed;
                }
                const target = "/work/result/model/design.json";
                const existed = py.FS.analyzePath(target).exists;
                const bytes = new TextEncoder().encode("concurrent root write\n");
                py.FS.writeFile(target, bytes);
                observe("delta-conflict", { path: "result/model/design.json", existed, sha256: digest(bytes) });
                return frame;
              },
            };
          },
        });
      },
    };
  }
  post(await runFormalPythonJob(data, guardedLoad, post));
});
