function createWorker(scriptURL) {
  return new Worker(new URL(scriptURL, import.meta.url), { type: "module" });
}

function buildError(data, fallback = "Build worker failed") {
  const details = [data.message, data.error?.message, data.error?.name ?? data.name]
    .filter(value => typeof value === "string" && value.trim());
  if (data.filename) {
    details.push([data.filename, data.lineno, data.colno]
      .filter(value => value !== undefined && value !== null).join(":"));
  }
  const error = new Error([...new Set(details)].join("; ") || fallback);
  if (data.error instanceof Error) error.cause = data.error;
  error.stage = data.stage;
  return error;
}

function request(worker, message, callbacks, operation) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      worker.removeEventListener("messageerror", onMessageError);
      if (operation.abort === abort) operation.abort = null;
    };
    const abort = (error) => {
      cleanup();
      reject(error);
    };
    const onMessage = ({ data }) => {
      if (data?.type === "stage") callbacks.onStage?.(data.stage);
      else if (data?.type === "progress") callbacks.onProgress?.(data.progress);
      else if (data?.type === "tools_ready") callbacks.onToolsReady?.();
      else if (data?.type === "log") callbacks.onLog?.(data);
      else if (data?.type === "error") {
        cleanup();
        reject(buildError(data));
      } else if (data?.type === "done") {
        cleanup();
        resolve(data);
      }
    };
    const onError = (event) => {
      cleanup();
      reject(buildError(event));
    };
    const onMessageError = (event) => {
      cleanup();
      reject(buildError(event, "Build worker message could not be deserialized"));
    };
    operation.abort = abort;
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.addEventListener("messageerror", onMessageError);
    try {
      worker.postMessage(message);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function createBuildRunner({
  createBuildWorker = () => createWorker("../build-worker.js"),
  createPackWorker = () => createWorker("../pack-worker.js"),
} = {}) {
  let packWorker = null;
  let active = null;

  function getPackWorker() {
    if (!packWorker) packWorker = createPackWorker();
    return packWorker;
  }

  async function build(input, callbacks = {}) {
    if (active) throw new Error("A build is already running");
    const operation = { abort: null, worker: null };
    active = operation;
    let buildWorker = null;
    try {
      buildWorker = createBuildWorker();
      operation.worker = buildWorker;
      const synthesized = await request(
        buildWorker,
        {
          type: "build",
          board: input.board,
          top: input.top,
          vhdlStandard: input.vhdlStandard,
          files: input.files,
          includeDirectories: input.includeDirectories,
          defines: input.defines,
        },
        callbacks,
        operation,
      );
      buildWorker.terminate();
      buildWorker = null;
      operation.worker = null;

      const netlist = synthesized.files.find(({ path }) => path === "build/top_pnr.json");
      if (!netlist) throw new Error("Build worker did not return build/top_pnr.json");
      const worker = getPackWorker();
      operation.worker = worker;
      const packed = await request(
        worker,
        { type: "pack", board: input.board, netlistJson: netlist.bytes },
        callbacks,
        operation,
      );
      return {
        files: [...synthesized.files, ...packed.files],
        timings: { ...synthesized.timings, ...packed.timings },
        memoryBytes: { ...synthesized.memoryBytes, ...packed.memoryBytes },
      };
    } finally {
      if (buildWorker) buildWorker.terminate();
      operation.worker = null;
      if (active === operation) active = null;
    }
  }

  function cancel() {
    if (!active) return false;
    const operation = active;
    const error = new Error("Build cancelled");
    error.name = "AbortError";
    if (operation.worker) {
      operation.worker.terminate();
      if (operation.worker === packWorker) packWorker = null;
      operation.worker = null;
    }
    operation.abort?.(error);
    return true;
  }

  function dispose() {
    cancel();
    if (packWorker) {
      packWorker.terminate();
      packWorker = null;
    }
  }

  return { build, cancel, dispose };
}
