import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const nativeDir = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");

export function assertCpuFrontendFailure(directory, files, options, modules, diagnostic) {
  const native = nativeSimulation(directory, files, options);
  const wasm = runIverilog({
    modules, files, top: "tb", sourceFiles: files.filter((file) => file.role !== "data" && /\.v$/i.test(file.path)).map((file) => file.path),
    includeDirs: ["src", ...options.includeDirectories], defines: options.defines,
  });
  const result = {
    native: { status: native.status, stdout: native.stdout, stderr: native.stderr },
    wasm: { status: wasm.status, stdout: wasm.stdout, stderr: wasm.stderr },
  };
  writeFileSync(path.join(directory, "frontend-results.json"), JSON.stringify(result, null, 2), { flag: "wx" });
  assert.ok(Number.isSafeInteger(native.status) && native.status > 0, native.stderr);
  assert.equal(wasm.status, native.status, wasm.stderr);
  assert.equal(wasm.stdout, native.stdout);
  assert.equal(wasm.stderr, native.stderr);
  assert.ok(native.stderr.includes(diagnostic), native.stderr);
  assert.doesNotMatch(native.stdout, /CPU_FUNCTION_OK/);
  assert.ok(!native.vcd && !wasm.tree?.work?.["wave.vcd"], "An unsupported frontend unexpectedly produced a waveform");
  return { tool: "iverilog", diagnostic, ...result };
}

export function nativeSimulation(directory, files, options) {
  for (const file of files) {
    const name = path.join(directory, "work", file.path);
    mkdirSync(path.dirname(name), { recursive: true });
    writeFileSync(name, file.content);
  }
  const run = (tool, args, cwd = directory) => {
    const result = spawnSync(path.join(nativeDir, tool), args, {
      cwd, encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SOURCE_DATE_EPOCH: "0", TZ: "UTC" },
    });
    writeFileSync(path.join(directory, `${tool}.stdout`), result.stdout ?? "");
    writeFileSync(path.join(directory, `${tool}.stderr`), result.stderr ?? "");
    writeFileSync(path.join(directory, `${tool}.json`), JSON.stringify({
      command: [path.join(nativeDir, tool), ...args], cwd,
      status: result.status, signal: result.signal, error: result.error?.message ?? null,
    }, null, 2));
    assert.ifError(result.error);
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  writeFileSync(path.join(directory, "work/ivlpp.flags"), [
    "I:work/src", ...options.includeDirectories.map((name) => `I:work/${name}`),
    ...Object.entries(options.defines).map(([name, value]) => `D:${name}=${value}`),
    ...(options.formal ? ["D:FORMAL=1"] : []),
  ].join("\n") + "\n");
  const preprocessed = run("ivlpp", ["-F", "work/ivlpp.flags", "-L", ...files.filter((file) => file.role !== "data" && /\.v$/i.test(file.path)).map((file) => `work/${file.path}`)]);
  if (preprocessed.status !== 0) return preprocessed;
  writeFileSync(path.join(directory, "work/preprocessed.v"), preprocessed.stdout);
  writeFileSync(path.join(directory, "work/ivl.conf"), ["module:system", "flag:DLL=vvp.tgt", "flag:VVP_EXECUTABLE=vvp", "functor:cprop", "functor:nodangle", `root:${options.top ?? "tb"}`, "out:work/design.vvp", `generation:${options.formal ? "2012" : "2"}`].join("\n"));
  const compiled = run("ivl", ["-C", "work/ivl.conf", "work/preprocessed.v"]);
  if (compiled.status !== 0) return compiled;
  const simulated = run("vvp", ["design.vvp"], path.join(directory, "work"));
  const vcd = path.join(directory, "work", options.vcdFile ?? "wave.vcd");
  return { ...simulated,
    stderr: [preprocessed.stderr, compiled.stderr, simulated.stderr].filter(Boolean).join("\n"),
    vcd: existsSync(vcd) ? readFileSync(vcd) : null };
}
