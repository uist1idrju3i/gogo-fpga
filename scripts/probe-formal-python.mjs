import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadPyodide } from "pyodide";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(values.out, "Use --out NEW_DIRECTORY");
mkdirSync(values.out);
const stdout = [], stderr = [];
try {
  const pyodide = await loadPyodide({ stdout: line => stdout.push(line), stderr: line => stderr.push(line) });
  const result = JSON.parse(pyodide.runPython(`
import sys, os, importlib, json
result = {"version": sys.version, "platform": sys.platform, "os_name": os.name, "modules": {}}
for name in ("resource", "fcntl", "subprocess", "select", "signal", "threading", "sqlite3"):
    info = {}
    result["modules"][name] = info
    try:
        module = importlib.import_module(name)
        info["import"] = "ok"
        if name == "resource":
            info["stack_limit"] = module.getrlimit(module.RLIMIT_STACK)
        elif name == "fcntl":
            info["getfl"] = module.F_GETFL
        elif name == "select":
            info["select"] = str(module.select([], [], [], 0))
        elif name == "threading":
            thread = module.Thread(target=lambda: None)
            thread.start()
            thread.join(1)
        elif name == "subprocess":
            module.Popen(["/nonexistent-probe"], stdin=module.PIPE, stdout=module.PIPE)
        elif name == "sqlite3":
            con = module.connect(":memory:")
            info["query"] = con.execute("select 1").fetchone()[0]
            con.close()
    except Exception as error:
        info["error"] = type(error).__name__ + ": " + str(error)
json.dumps(result, sort_keys=True)
`));
  const dependency = path.join(import.meta.dirname, "../node_modules/pyodide");
  const assets = Object.fromEntries(["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"].map(name => {
    const bytes = readFileSync(path.join(dependency, name));
    return [name, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }));
  writeFileSync(path.join(values.out, "result.json"), JSON.stringify({ format: 1, preliminary: true, node: process.version,
    packageVersion: JSON.parse(readFileSync(path.join(dependency, "package.json"))).version, assets, result }, null, 2) + "\n");
  console.log(JSON.stringify(result));
} catch (error) {
  stderr.push(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(values.out, "stdout.log"), stdout.join("\n"));
  writeFileSync(path.join(values.out, "stderr.log"), stderr.join("\n"));
}
