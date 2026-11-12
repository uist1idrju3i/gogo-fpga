import { parseToolDiagnostics } from "./tool-diagnostics.mjs";

export const NO_VCD_MESSAGE =
  "VCD が出力されていません。testbench の $dumpfile と $dumpvars を確かめてください。";

function isFileContent(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function collectVcdFiles(tree, parent = "") {
  if (isFileContent(tree)) return [];
  if (tree === null || typeof tree !== "object") return [];
  return Object.entries(tree).flatMap(([name, value]) => {
    const path = parent ? `${parent}/${name}` : name;
    if (isFileContent(value)) {
      return /\.vcd$/i.test(name)
        ? [{ name: path, bytes: new Uint8Array(value) }]
        : [];
    }
    return collectVcdFiles(value, path);
  });
}

export function vcdRootScopes(bytes) {
  const roots = new Set();
  let depth = 0;
  const header = new TextDecoder().decode(bytes);
  for (const [, directive, body] of header.matchAll(/\$(\w+)\b([\s\S]*?)\$end(?=\s|$)/g)) {
    if (directive === "enddefinitions") break;
    if (directive === "scope") {
      const [, name] = body.trim().split(/\s+/);
      if (depth === 0 && name) roots.add(name);
      depth += 1;
    } else if (directive === "upscope") {
      depth = Math.max(0, depth - 1);
    }
  }
  return [...roots];
}

export function extractVcd(tree) {
  const files = collectVcdFiles(tree).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  const index = files.findIndex(({ name }) => name.split("/").at(-1) === "wave.vcd");
  return {
    vcd: files[index < 0 ? 0 : index] ?? null,
    vcds: files,
  };
}

function emptyResult(outcome, stderr = "") {
  return {
    outcome,
    status: null,
    stdout: "",
    stderr,
    vcd: null,
    vcds: [],
    diagnostics: [],
  };
}

function normalizeResult(data, files) {
  const result = data.result ?? {};
  const stdout = String(result.stdout ?? "");
  let stderr = String(result.stderr ?? "");
  const { vcd, vcds } = extractVcd(result.tree);
  const diagnostics = (result.diagnosticText ?? []).flatMap(({ tool, text }) =>
    parseToolDiagnostics(tool, text)
  );
  const knownPaths = new Set(
    Array.isArray(files) ? files.map(({ path }) => path) : [],
  );
  for (const diagnostic of diagnostics) {
    if (diagnostic.file && !knownPaths.has(diagnostic.file)) {
      diagnostic.file = null;
    }
  }
  const hasVcd = vcd !== null;
  if (!hasVcd && result.status === 0) {
    stderr += `${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${NO_VCD_MESSAGE}`;
    diagnostics.push({ file: null, severity: "error", message: NO_VCD_MESSAGE });
  }
  return {
    outcome: result.status === 0 && hasVcd ? "ok" : "failed",
    status: result.status ?? 1,
    stdout,
    stderr,
    vcd,
    vcds,
    diagnostics,
  };
}

export function createSimRunner({
  createSimWorker = () =>
    new Worker(new URL("../sim-worker.js", import.meta.url), { type: "module" }),
  moduleLoadTimeoutMs = 60_000,
} = {}) {
  let worker = null;
  let active = null;

  function getWorker() {
    if (!worker) worker = createSimWorker();
    return worker;
  }

  function run({ files, top, timeLimitMs, includeDirectories, defines }) {
    if (active) {
      return Promise.reject(new Error("A simulation is already running"));
    }
    if (!Number.isFinite(timeLimitMs) || timeLimitMs <= 0) {
      return Promise.resolve(emptyResult("failed", "Invalid simulation time limit"));
    }
    const operation = {
      worker: getWorker(),
      resolve: null,
      loadTimeout: null,
      timeout: null,
      started: false,
    };
    active = operation;
    return new Promise((resolve) => {
      operation.resolve = resolve;
      const cleanup = () => {
        clearTimeout(operation.loadTimeout);
        clearTimeout(operation.timeout);
        operation.worker.removeEventListener("message", onMessage);
        operation.worker.removeEventListener("error", onError);
        operation.worker.removeEventListener("messageerror", onMessageError);
        if (active === operation) active = null;
      };
      const finish = (result, terminate = false) => {
        cleanup();
        if (terminate) {
          operation.worker.terminate();
          if (worker === operation.worker) worker = null;
        }
        resolve(result);
      };
      operation.finish = finish;
      const onMessage = ({ data }) => {
        if (data?.type === "started" && !operation.started) {
          operation.started = true;
          clearTimeout(operation.loadTimeout);
          operation.loadTimeout = null;
          operation.timeout = setTimeout(() => {
            finish(emptyResult("timeout"), true);
          }, timeLimitMs);
        } else if (data?.type === "done") {
          finish(normalizeResult(data, files));
        } else if (data?.type === "error") {
          finish(emptyResult("failed", String(data.message ?? "Simulation worker failed")), true);
        }
      };
      const onError = (event) => {
        finish(emptyResult("failed", String(event.message ?? "Simulation worker failed")), true);
      };
      const onMessageError = () => {
        finish(emptyResult("failed", "Simulation worker message could not be deserialized"), true);
      };
      operation.worker.addEventListener("message", onMessage);
      operation.worker.addEventListener("error", onError);
      operation.worker.addEventListener("messageerror", onMessageError);
      operation.loadTimeout = setTimeout(() => {
        finish(
          emptyResult("failed", "Icarus WASM module loading timed out"),
          true,
        );
      }, moduleLoadTimeoutMs);
      try {
        operation.worker.postMessage({ files, top, includeDirectories, defines });
      } catch (error) {
        finish(emptyResult("failed", String(error)), true);
      }
    });
  }

  function stop() {
    if (!active) return false;
    const operation = active;
    operation.finish(emptyResult("stopped"), true);
    return true;
  }

  function dispose() {
    stop();
    if (worker) {
      worker.terminate();
      worker = null;
    }
  }

  return { run, stop, dispose };
}
