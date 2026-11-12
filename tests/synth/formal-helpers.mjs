import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryTree, runWasiP1, treeToObject } from "../../web/lib/wasi-p1.mjs";
import { assertYosysCreator } from "./yosys-parity.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const nativePath = path.join(root, "build/native/yosys");
const wasm = new WebAssembly.Module(readFileSync(path.join(root, "build/wasi/yosys/yosys.wasm")));

export function createFormalExecutors(evidence, name, source) {
  const directory = path.join(evidence, name);
  mkdirSync(directory);
  const nativeDir = path.join(directory, "native");
  mkdirSync(nativeDir);
  mkdirSync(path.join(nativeDir, "__formal"));
  writeFileSync(path.join(nativeDir, "top.v"), source);
  const workspace = createMemoryTree({ "top.v": source, __formal: {}, tmp: {} });
  function save(phase, result) {
    writeFileSync(path.join(directory, `${phase}.stdout`), result.stdout);
    writeFileSync(path.join(directory, `${phase}.stderr`), result.stderr);
    for (const name of ["before.json", "after.json"]) {
      const bytes = result.files.get(`__formal/${name}`);
      if (bytes) assertYosysCreator(JSON.parse(new TextDecoder().decode(bytes)).creator);
    }
    return result;
  }
  return {
    native: async ({ phase, script }) => {
      writeFileSync(path.join(directory, `native-${phase}.ys`), script);
      const result = spawnSync(nativePath, ["-Q", "-T", "-p", script], {
        cwd: nativeDir, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
      assert.ifError(result.error);
      return save(`native-${phase}`, {
        exitCode: result.status, stdout: result.stdout, stderr: result.stderr,
        files: new Map(readdirSync(path.join(nativeDir, "__formal")).map((filename) =>
          [`__formal/${filename}`, readFileSync(path.join(nativeDir, "__formal", filename))])),
      });
    },
    wasm: async ({ phase, script }) => {
      writeFileSync(path.join(directory, `wasm-${phase}.ys`), script);
      const stdout = [];
      const stderr = [];
      const result = runWasiP1(wasm, {
        args: ["yosys", "-Q", "-T", "-p", script], env: { TMPDIR: "/tmp" },
        preopens: { "/": workspace, "/tmp": workspace.entries.get("tmp") },
        stdout: (bytes) => stdout.push(bytes), stderr: (bytes) => stderr.push(bytes),
      });
      const files = new Map(Object.entries(treeToObject(workspace).__formal).map(([filename, bytes]) => {
        writeFileSync(path.join(directory, `wasm-${filename}`), bytes);
        return [`__formal/${filename}`, bytes];
      }));
      return save(`wasm-${phase}`, {
        ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), files,
      });
    },
  };
}
