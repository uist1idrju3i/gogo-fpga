import { createFormalProcessClient } from "./formal-process-client.mjs";
import { createFormalToolClient } from "./formal-tool-client.mjs";
import { safePath, verifyManifest } from "./verified-assets.mjs";

export async function runFormalPythonJob(data, loadPyodide, postMessage) {
  const { jobId, sources, manifest, entrypoint, args, files, cwd = null } = data;
  let status = "setup-error";
  try {
    if (typeof jobId !== "string" || !["smtbmc", "sby", "witness", "formal_trace"].includes(entrypoint) ||
        (cwd !== null && (!safePath(cwd) || cwd.includes("\0") || cwd.length > 512)) ||
        !Array.isArray(args) || args.length > 64 || !args.every(arg => typeof arg === "string" && arg.length < 4096 && !arg.includes("\0"))) {
      throw new TypeError("Invalid formal Python job");
    }
    const assets = verifyManifest(manifest, "Formal Python");
    if (!assets.has(`${entrypoint}.py`) || assets.size > 256 || !Array.isArray(sources) || sources.length !== assets.size) throw new Error("Invalid formal source count");
    status = "integrity-error";
    const seen = new Set();
    let sourceBytes = 0;
    for (const { path, bytes } of sources) {
      const asset = assets.get(path);
      if (!asset || path.includes("\0") || asset.encoding !== undefined || seen.has(path) || !(bytes instanceof Uint8Array) || bytes.length !== asset.size) throw new Error("Invalid formal source asset");
      seen.add(path);
      sourceBytes += bytes.length;
      if (sourceBytes > 32 * 1024 * 1024) throw new Error("Formal Python source limit");
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(n => n.toString(16).padStart(2, "0")).join("");
      if (hash !== asset.sha256) throw new Error(`Formal Python source hash mismatch: ${path}`);
    }
    status = "setup-error";
    let fileBytes = 0;
    const inputPaths = new Set();
    if (!Array.isArray(files) || files.length > 4096) throw new Error("Invalid formal input files");
    for (const { path, bytes } of files) {
      if (!safePath(path) || path.includes("\0") || inputPaths.has(path) || !(bytes instanceof Uint8Array)) throw new Error("Invalid formal input path or bytes");
      inputPaths.add(path);
      fileBytes += bytes.length;
      if (fileBytes > 32 * 1024 * 1024) throw new Error("Formal input file limit");
    }
    status = "runtime-error";
    const pyodide = await loadPyodide({
      stdout: line => postMessage({ type: "stdout", jobId, text: line + "\n" }),
      stderr: line => postMessage({ type: "stderr", jobId, text: line + "\n" }),
    });
    const { FS } = pyodide;
    FS.mkdir("/upstream"); FS.mkdir("/work");
    for (const { path, bytes } of sources) {
      FS.mkdirTree(`/upstream/${path.split("/").slice(0, -1).join("/")}`);
      FS.writeFile(`/upstream/${path}`, bytes);
    }
    for (const { path, bytes } of files) {
      FS.mkdirTree(`/work/${path.split("/").slice(0, -1).join("/")}`);
      FS.writeFile(`/work/${path}`, bytes);
    }
    pyodide.registerJsModule("_formal_host", { ...createFormalProcessClient(postMessage, jobId),
      ...createFormalToolClient(postMessage, jobId, FS) });
    pyodide.globals.set("_formal_args", args);
    pyodide.globals.set("_formal_entry", entrypoint);
    pyodide.globals.set("_formal_cwd", cwd ?? "");
    const exitCode = pyodide.runPython(`
import gc, os, sys, runpy, traceback
sys.path.insert(0, "/upstream")
sys.dont_write_bytecode = True
sys.argv = [_formal_entry] + list(_formal_args.to_py())
os.chdir("/work/" + _formal_cwd)
os.environ["MAKEFLAGS"] = ""
_formal_exit = 0
_formal_failed = False
try:
    runpy.run_path("/upstream/" + _formal_entry + ".py", run_name="__main__")
except SystemExit as error:
    _formal_exit = error.code if isinstance(error.code, int) else 0 if error.code is None else 1
except BaseException:
    traceback.print_exc()
    _formal_failed = True
    _formal_exit = 1
gc.collect()
sys.stdout.flush()
sys.stderr.flush()
_formal_exit
`);
    if (pyodide.globals.get("_formal_failed") === true) throw new Error("Upstream Python raised an exception");
    const output = [];
    let outputBytes = 0;
    function collect(directory, prefix = "") {
      for (const name of FS.readdir(directory).filter(p => p !== "." && p !== "..").sort()) {
        const path = prefix + name;
        const absolute = `${directory}/${name}`;
        const { mode } = FS.lstat(absolute);
        if (FS.isDir(mode)) collect(absolute, path + "/");
        else if (FS.isFile(mode)) {
          const bytes = FS.readFile(absolute);
          outputBytes += bytes.length;
          if (outputBytes > 32 * 1024 * 1024 || output.length >= 4096) throw new Error("Formal output file limit");
          output.push({ path, bytes });
        } else throw new Error("Unsupported formal output file type");
      }
    }
    collect("/work");
    return { type: "exit", jobId, status: "exited", exitCode, files: output, integrityVerified: true };
  } catch (error) {
    return { type: "failure", jobId, status, error: String(error.message).slice(0, 1024) };
  }
}
