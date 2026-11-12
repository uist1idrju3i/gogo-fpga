import { runIverilog } from "./lib/iverilog-host.mjs";
import { validateCompileOptions } from "./lib/libraries.mjs";

const moduleNames = ["ivlpp", "ivl", "vvp"];
const moduleCache = new Map();
const decoder = new TextDecoder();
let running = false;

function loadModule(name) {
  if (!moduleCache.has(name)) {
    const promise = fetch(new URL(`./iverilog/${name}.wasm`, import.meta.url))
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Unable to load ${name}.wasm: HTTP ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.compile(bytes));
    moduleCache.set(name, promise);
  }
  return moduleCache.get(name);
}

function directoryOf(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function decodeOutput(value) {
  return typeof value === "string" ? value : decoder.decode(value ?? new Uint8Array());
}

self.addEventListener("message", async ({ data }) => {
  if (running) {
    self.postMessage({ type: "error", message: "A simulation is already running" });
    return;
  }
  running = true;
  try {
    if (!Array.isArray(data?.files) || data.files.length === 0) {
      throw new Error("The simulation has no Verilog files");
    }
    const sourceFiles = data.files
      .filter(({ path, role }) => role !== "data" && /\.v$/i.test(path))
      .map(({ path }) => path);
    if (sourceFiles.length === 0) {
      throw new Error("The simulation has no Verilog source files");
    }
    const options = validateCompileOptions(data);
    const modules = Object.fromEntries(
      await Promise.all(moduleNames.map(async (name) => [name, await loadModule(name)])),
    );
    self.postMessage({ type: "started" });
    const result = runIverilog({
      modules,
      files: data.files,
      sourceFiles,
      top: data.top,
      includeDirs: [...new Set([...options.includeDirectories, ...data.files.map(({ path }) => directoryOf(path)).filter(Boolean)])],
      defines: options.defines,
    });
    const diagnosticText = Object.entries(result.stages).map(([tool, stage]) => ({
      tool,
      text: decodeOutput(stage.stderr),
    }));
    self.postMessage({
      type: "done",
      result: {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        diagnosticText,
        tree: result.tree,
      },
    });
  } catch (error) {
    self.postMessage({ type: "error", message: error.message });
  } finally {
    running = false;
  }
});
