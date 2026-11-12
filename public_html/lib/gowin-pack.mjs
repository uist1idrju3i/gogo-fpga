const runtimeCache = new WeakMap();

function nodeBuiltins() {
  return globalThis.process?.versions?.node
    ? globalThis.process.getBuiltinModule
      ? {
          fs: globalThis.process.getBuiltinModule("fs"),
          path: globalThis.process.getBuiltinModule("path"),
          url: globalThis.process.getBuiltinModule("url"),
        }
      : null
    : null;
}

function normalizeIndexURL(indexURL) {
  if (typeof indexURL !== "string" || indexURL.length === 0) {
    throw new TypeError("indexURL must be a non-empty string");
  }
  const builtins = nodeBuiltins();
  if (builtins) {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(indexURL)) {
      const parsed = new URL(indexURL);
      if (parsed.protocol !== "file:") {
        throw new TypeError("Node.js indexURL must be a local path or file URL");
      }
      return builtins.path.resolve(builtins.url.fileURLToPath(parsed));
    }
    return builtins.path.resolve(indexURL);
  }
  const url = new URL(indexURL, globalThis.location?.href).href;
  return url.endsWith("/") ? url : `${url}/`;
}

function normalizeWheelURL(wheelURL) {
  if (typeof wheelURL !== "string" || wheelURL.length === 0) {
    throw new TypeError("apyculaWheelURL must be a non-empty string");
  }
  const builtins = nodeBuiltins();
  if (builtins) {
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(wheelURL)) {
      const parsed = new URL(wheelURL);
      if (parsed.protocol !== "file:") {
        throw new TypeError("Node.js apyculaWheelURL must be a local path or file URL");
      }
      return parsed.href;
    }
    return builtins.url.pathToFileURL(builtins.path.resolve(wheelURL)).href;
  }
  return new URL(wheelURL, globalThis.location?.href).href;
}

async function readWheel(url) {
  if (typeof url !== "string" || url.length === 0) {
    throw new TypeError("apyculaWheelURL must be a non-empty string");
  }
  const builtins = nodeBuiltins();
  if (builtins) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "file:") {
        return builtins.fs.readFileSync(builtins.url.fileURLToPath(parsed));
      }
    } catch (error) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) {
        throw error;
      }
    }
    if (!/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url)) {
      return builtins.fs.readFileSync(builtins.path.resolve(url));
    }
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load Apicula wheel (${response.status}): ${url}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function wheelFilename(url) {
  const builtins = nodeBuiltins();
  let filename;
  if (builtins) {
    try {
      const parsed = new URL(url);
      filename =
        parsed.protocol === "file:"
          ? builtins.path.basename(builtins.url.fileURLToPath(parsed))
          : builtins.path.basename(parsed.pathname);
    } catch {
      filename = builtins.path.basename(url);
    }
  } else {
    const parsed = new URL(url, globalThis.location?.href);
    filename = decodeURIComponent(parsed.pathname.split("/").pop() ?? "");
  }
  if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(filename)) {
    throw new TypeError(`apyculaWheelURL must identify a wheel filename: ${url}`);
  }
  return filename;
}

async function initializeRuntime(
  loadPyodide,
  indexURL,
  wheelURL,
  lockFileContents,
) {
  const localWheelURL = normalizeWheelURL(wheelURL);
  const wheel = await readWheel(localWheelURL);
  if (wheel.byteLength === 0) {
    throw new Error(`Apicula wheel is empty: ${wheelURL}`);
  }
  wheelFilename(localWheelURL);
  const pyodideIndexURL = normalizeIndexURL(indexURL);
  const builtins = nodeBuiltins();
  const lockFileURL = builtins
    ? builtins.path.join(pyodideIndexURL, "pyodide-lock.json")
    : new URL("pyodide-lock.json", pyodideIndexURL).href;
  const packageBaseUrl = builtins
    ? `${builtins.path.resolve(pyodideIndexURL, "../wheels")}${builtins.path.sep}`
    : new URL("../wheels/", pyodideIndexURL).href;
  const loadOptions = {
    indexURL: pyodideIndexURL,
    packageBaseUrl,
  };
  if (lockFileContents === undefined) {
    loadOptions.lockFileURL = lockFileURL;
  } else {
    loadOptions.lockFileContents = lockFileContents;
  }
  const pyodide = await loadPyodide(loadOptions);
  await pyodide.loadPackage(["micropip", "numpy", "msgspec"]);
  pyodide.FS.mkdir("/work");
  await pyodide.runPythonAsync(
    `import micropip\nawait micropip.install(${JSON.stringify(localWheelURL)}, deps=False)`,
  );
  await pyodide.runPythonAsync("import lzma");
  return pyodide;
}

function getRuntime(loadPyodide, indexURL, wheelURL, lockFileContents) {
  let runtimes = runtimeCache.get(loadPyodide);
  if (!runtimes) {
    runtimes = new Map();
    runtimeCache.set(loadPyodide, runtimes);
  }
  const lockKey =
    lockFileContents === undefined ? "" : JSON.stringify(lockFileContents);
  const key = `${indexURL}\u0000${wheelURL}\u0000${lockKey}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = initializeRuntime(
      loadPyodide,
      indexURL,
      wheelURL,
      lockFileContents,
    );
    runtimes.set(key, runtime);
    runtime.catch(() => runtimes.delete(key));
  }
  return runtime;
}

function packPythonScript(argv) {
  return `
import contextlib
import io
import json
import sys
import traceback

captured_stdout = io.StringIO()
captured_stderr = io.StringIO()
exit_code = 0
try:
    with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
        import apycula.gowin_pack
        sys.argv = ${JSON.stringify(argv)}
        apycula.gowin_pack.main()
except SystemExit as error:
    if error.code is None:
        exit_code = 0
    elif isinstance(error.code, int):
        exit_code = error.code
    else:
        exit_code = 1
        captured_stderr.write(str(error.code))
except BaseException:
    exit_code = 1
    traceback.print_exc(file=captured_stderr)
json.dumps({
    "exitCode": exit_code,
    "stdout": captured_stdout.getvalue(),
    "stderr": captured_stderr.getvalue(),
})
`;
}

function packError(message, result = {}) {
  const error = new Error(message);
  error.stdout = result.stdout ?? "";
  error.stderr = result.stderr ?? "";
  return error;
}

export async function prepareGowinPackRuntime({
  loadPyodide,
  indexURL,
  apyculaWheelURL,
  lockFileContents,
}) {
  if (typeof loadPyodide !== "function") {
    throw new TypeError("loadPyodide must be a function");
  }
  await getRuntime(loadPyodide, indexURL, apyculaWheelURL, lockFileContents);
}

export async function runGowinPack({
  loadPyodide,
  indexURL,
  apyculaWheelURL,
  lockFileContents,
  netlistJson,
  device,
  extraArgs = [],
}) {
  if (typeof loadPyodide !== "function") {
    throw new TypeError("loadPyodide must be a function");
  }
  if (typeof device !== "string" || device.length === 0) {
    throw new TypeError("device must be a non-empty string");
  }
  if (typeof netlistJson !== "string" && !(netlistJson instanceof Uint8Array)) {
    throw new TypeError("netlistJson must be a string or Uint8Array");
  }
  if (!Array.isArray(extraArgs) || extraArgs.some((argument) => typeof argument !== "string")) {
    throw new TypeError("extraArgs must be an array of strings");
  }

  const pyodide = await getRuntime(
    loadPyodide,
    indexURL,
    apyculaWheelURL,
    lockFileContents,
  );
  const input =
    typeof netlistJson === "string" ? new TextEncoder().encode(netlistJson) : netlistJson;
  const outputPath = "/work/top.fs";
  try {
    pyodide.FS.unlink(outputPath);
  } catch (error) {
    if (error.code !== "ENOENT" && error.errno !== 44) {
      throw error;
    }
  }
  pyodide.FS.writeFile("/work/top.json", input);

  const argv = [
    "gowin_pack",
    "-d",
    device,
    "-o",
    outputPath,
    "/work/top.json",
    ...extraArgs,
  ];
  let result;
  try {
    result = JSON.parse(await pyodide.runPythonAsync(packPythonScript(argv)));
  } catch (error) {
    throw packError(`Apicula gowin_pack failed: ${error.message}`);
  }
  if (result.exitCode !== 0) {
    throw packError(
      `Apicula gowin_pack exited with status ${result.exitCode}:\n${result.stderr}`,
      result,
    );
  }

  let fs;
  try {
    fs = pyodide.FS.readFile(outputPath);
  } catch {
    throw packError(`Apicula gowin_pack did not create ${outputPath}`, result);
  }
  if (fs.byteLength === 0) {
    throw packError(`Apicula gowin_pack created an empty ${outputPath}`, result);
  }
  return {
    fs: new Uint8Array(fs),
    stdout: result.stdout,
    stderr: result.stderr,
      memoryBytes: pyodide._module?.HEAPU8?.buffer?.byteLength ?? null,
  };
}
