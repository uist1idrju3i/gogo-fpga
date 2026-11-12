import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { WASI } from "node:wasi";
import { BOARDS } from "../web/lib/boards.mjs";
import { createBlinkTemplate, generateCst } from "../web/lib/templates.mjs";
import {
  pnrArgs,
  root,
  wasiSharePath,
  wasmModule,
  yosysModule,
  yosysSharePath,
} from "../tests/synth/nextpnr-helpers.mjs";

const usage = "Usage: node scripts/s5-wasi-runner.mjs --board ID --workdir PATH";

function argument(name) {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], usage);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function closeDescriptor(descriptor) {
  try {
    closeSync(descriptor);
  } catch (error) {
    if (error.code !== "EBADF") {
      throw error;
    }
  }
}

function runWasi(module, args, workdir, sharePath, prefix) {
  const stdoutPath = path.join(workdir, `${prefix}.stdout`);
  const stderrPath = path.join(workdir, `${prefix}.stderr`);
  const stdout = openSync(stdoutPath, "w");
  const stderr = openSync(stderrPath, "w");
  const wasi = new WASI({
    version: "preview1",
    args,
    env: { TMPDIR: "/tmp" },
    preopens: {
      "/": workdir,
      "/share": sharePath,
      "/tmp": path.join(workdir, "tmp"),
    },
    stdout,
    stderr,
    returnOnExit: true,
  });
  const started = performance.now();
  let instance;
  let status = 1;
  let error;
  try {
    instance = new WebAssembly.Instance(module, wasi.getImportObject());
    status = wasi.start(instance);
  } catch (caught) {
    error = caught;
  } finally {
    closeDescriptor(stdout);
    closeDescriptor(stderr);
  }
  const elapsed = performance.now() - started;
  const memory = instance?.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error(`${prefix} did not expose WebAssembly.Memory`);
  }
  const stderrText = readFileSync(stderrPath, "utf8");
  if (error || status !== 0) {
    throw new Error(
      `${prefix} exited with status ${status}: ${error ?? ""}\n${stderrText}`,
    );
  }
  return {
    elapsed,
    memoryBytes: memory.buffer.byteLength,
  };
}

function main() {
  const boardId = argument("--board");
  const workdir = path.resolve(root, argument("--workdir"));
  const board = BOARDS.find(({ id }) => id === boardId);
  assert.ok(board, `Unknown board: ${boardId}`);
  assert.ok(!existsSync(workdir), `Refusing to overwrite run output: ${workdir}`);
  mkdirSync(path.join(workdir, "src"), { recursive: true });
  mkdirSync(path.join(workdir, "constraints"));
  mkdirSync(path.join(workdir, "tmp"));

  const template = createBlinkTemplate(board.id, "verilog");
  const source = template.files.get("src/top.v");
  assert.equal(typeof source, "string", `Missing Verilog template for ${board.id}`);
  writeFileSync(path.join(workdir, "src/top.v"), source);
  writeFileSync(path.join(workdir, "constraints/board.cst"), generateCst(board.id));

  const synth = runWasi(
    yosysModule,
    [
      "yosys",
      "-q",
      "-p",
      "read_verilog src/top.v; synth_gowin -top top -json top.json",
    ],
    workdir,
    yosysSharePath,
    "yosys",
  );
  const netlist = readFileSync(path.join(workdir, "top.json"));
  writeFileSync(path.join(workdir, "netlist.json"), netlist);
  const pnr = runWasi(
    wasmModule,
    ["nextpnr-himbaechel-gowin", ...pnrArgs(board)],
    workdir,
    wasiSharePath,
    "nextpnr",
  );
  const routed = readFileSync(path.join(workdir, "pnr.json"));
  writeFileSync(path.join(workdir, "top.json"), routed);

  const packStarted = performance.now();
  const packer = path.join(root, "build/deps/apycula-venv/bin/gowin_pack");
  const result = spawnSync(
    packer,
    ["-d", board.packDevice, "-o", "top.fs", "top.json"],
    {
      cwd: workdir,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: path.join(workdir, "tmp") },
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  writeFileSync(path.join(workdir, "gowin-pack.stdout"), result.stdout ?? "");
  writeFileSync(path.join(workdir, "gowin-pack.stderr"), result.stderr ?? "");
  assert.equal(
    result.status,
    0,
    `Native gowin_pack failed: ${result.stderr ?? ""}\n${result.error ?? ""}`,
  );
  const fs = readFileSync(path.join(workdir, "top.fs"));
  assert.ok(fs.byteLength > 0, "gowin_pack produced an empty top.fs");
  const metric = {
    board: board.id,
    synth_ms: synth.elapsed,
    nextpnr_ms: pnr.elapsed,
    yosys_memory_bytes: synth.memoryBytes,
    nextpnr_memory_bytes: pnr.memoryBytes,
    netlist_sha256: sha256(netlist),
    pnr_sha256: sha256(routed),
    fs_sha256: sha256(fs),
    fs_bytes: fs.byteLength,
    pack_ms: performance.now() - packStarted,
  };
  writeFileSync(path.join(workdir, "result.json"), `${JSON.stringify(metric, null, 2)}\n`);
  console.log(`S5_NODE_METRIC ${JSON.stringify(metric)}`);
}

try {
  main();
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
}
