import assert from "node:assert/strict";
import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import { WASI } from "node:wasi";
import { BOARDS } from "../../web/lib/boards.mjs";
import { createBlinkTemplate, generateCst } from "../../web/lib/templates.mjs";
import {
  createMemoryTree,
  runWasiP1,
  treeToObject,
} from "../../web/lib/wasi-p1.mjs";
import {
  createWorkdir,
  nextpnrWasmPath,
  pnrArgs,
  runWasi,
  runYosysWasi,
  wasiSharePath,
  yosysModule,
  yosysSharePath,
} from "./nextpnr-helpers.mjs";

const nextpnrModule = new WebAssembly.Module(readFileSync(nextpnrWasmPath));
const yosysCommand = [
  "yosys",
  "-q",
  "-p",
  "read_verilog src/top.v; synth_gowin -top top -json top.json",
];

test("Yosys WASI reads a sibling source from the selected working directory", () => {
  const tree = createMemoryTree({
    job: { src: { "top.v": "module top(); endmodule\n" }, model: {
      "design.ys": "read_verilog ../src/top.v\nwrite_json design.json\n",
    } },
  });
  const workingDirectory = tree.entries.get("job").entries.get("model");
  const output = [];
  const oldBoundary = runWasiP1(yosysModule, {
    args: ["yosys", "-Q", "-T", "-q", "design.ys"],
    preopens: { "/": tree, ".": workingDirectory },
    stderr: bytes => output.push(new TextDecoder().decode(bytes)),
  });
  assert.equal(oldBoundary.exitCode, 1);
  assert.match(output.join(""), /File `\.\.\/src\/top\.v' not found/);
  output.length = 0;
  const result = runWasiP1(yosysModule, {
    args: ["yosys", "-Q", "-T", "-q", "design.ys"],
    preopens: { "/": tree }, workingDirectory,
    stderr: bytes => output.push(new TextDecoder().decode(bytes)),
  });
  assert.equal(result.exitCode, 0, output.join(""));
  assert.ok(workingDirectory.entries.get("design.json")?.data.length > 0);
  assert.throws(() => runWasiP1(yosysModule, {
    args: ["yosys", "-V"], preopens: { "/": tree }, workingDirectory: createMemoryTree({}),
  }), /Working directory must be within the root preopen/);
  const cyclic = createMemoryTree({});
  cyclic.parent = cyclic;
  assert.throws(() => runWasiP1(yosysModule, {
    args: ["yosys", "-V"], preopens: { "/": tree }, workingDirectory: cyclic,
  }), /cyclic parent/);
});

function readTree(directory) {
  const result = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    result[entry.name] = entry.isDirectory()
      ? readTree(entryPath)
      : readFileSync(entryPath);
  }
  return result;
}

function chunksToBytes(chunks) {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function runNodeWasi(module, workdir, args, sharePath) {
  const stdoutPath = path.join(workdir, "reference.stdout");
  const stderrPath = path.join(workdir, "reference.stderr");
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
  let status = 1;
  let error;
  try {
    status = wasi.start(new WebAssembly.Instance(module, wasi.getImportObject()));
  } catch (caught) {
    error = caught;
  } finally {
    for (const fd of [stdout, stderr]) closeSync(fd);
  }
  return {
    status: Number.isInteger(status) ? status : 0,
    stdout: readFileSync(stdoutPath),
    stderr: readFileSync(stderrPath),
    error,
  };
}

function runShim(module, tree, shareTree, args, clockTime = null) {
  const workdir = createMemoryTree(tree);
  const share = createMemoryTree(shareTree);
  const outputChunks = [];
  const errorChunks = [];
  const result = runWasiP1(module, {
    args,
    env: { TMPDIR: "/tmp" },
    preopens: {
      "/": workdir,
      "/share": share,
      "/tmp": workdir.entries.get("tmp"),
    },
    stdout: (bytes) => outputChunks.push(bytes),
    stderr: (bytes) => errorChunks.push(bytes),
    clockTime,
  });
  return {
    ...result,
    tree: workdir,
    stdout: chunksToBytes(outputChunks),
    stderr: chunksToBytes(errorChunks),
  };
}

function makeWorkTree(source, board, topJson) {
  const tree = {
    src: { "top.v": source },
    constraints: { "board.cst": generateCst(board.id) },
    tmp: {},
  };
  if (topJson) tree["top.json"] = topJson;
  return tree;
}

function bytesAt(tree, name) {
  const value = treeToObject(tree)[name];
  assert.ok(value instanceof Uint8Array, `${name} was not created`);
  return value;
}

function relevantLines(bytes, pattern) {
  return new TextDecoder()
    .decode(bytes)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .filter((line) => pattern.test(line));
}

function encodeU32(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
}

function encodeS32(value) {
  const bytes = [];
  let remaining = value | 0;
  let more = true;
  while (more) {
    let byte = remaining & 0x7f;
    remaining >>= 7;
    more = !((remaining === 0 && (byte & 0x40) === 0) ||
      (remaining === -1 && (byte & 0x40) !== 0));
    if (more) byte |= 0x80;
    bytes.push(byte);
  }
  return bytes;
}

function section(id, payload) {
  return [id, ...encodeU32(payload.length), ...payload];
}

function wasmHarness(imports, instructions, dataSegments = []) {
  const encoder = new TextEncoder();
  const types = [];
  const typeIndexes = new Map();
  for (const entry of imports) {
    const signature = JSON.stringify(entry.type);
    if (!typeIndexes.has(signature)) {
      typeIndexes.set(signature, types.length);
      types.push(entry.type);
    }
  }
  const startSignature = JSON.stringify({ params: [], results: [] });
  if (!typeIndexes.has(startSignature)) {
    typeIndexes.set(startSignature, types.length);
    types.push({ params: [], results: [] });
  }
  const typePayload = [
    ...encodeU32(types.length),
    ...types.flatMap(({ params, results }) => [
      0x60,
      ...encodeU32(params.length),
      ...params,
      ...encodeU32(results.length),
      ...results,
    ]),
  ];
  const importPayload = [
    ...encodeU32(imports.length),
    ...imports.flatMap((entry) => {
      const moduleName = encoder.encode("wasi_snapshot_preview1");
      const functionName = encoder.encode(entry.name);
      return [
        ...encodeU32(moduleName.length),
        ...moduleName,
        ...encodeU32(functionName.length),
        ...functionName,
        0,
        ...encodeU32(typeIndexes.get(JSON.stringify(entry.type))),
      ];
    }),
  ];
  const functionPayload = [
    1,
    ...encodeU32(typeIndexes.get(startSignature)),
  ];
  const memoryPayload = [1, 0, 1];
  const exports = [
    { name: "memory", kind: 2, index: 0 },
    { name: "_start", kind: 0, index: imports.length },
  ];
  const exportPayload = [
    ...encodeU32(exports.length),
    ...exports.flatMap(({ name, kind, index }) => {
      const bytes = encoder.encode(name);
      return [...encodeU32(bytes.length), ...bytes, kind, ...encodeU32(index)];
    }),
  ];
  const body = [0, ...instructions, 0x0b];
  const codePayload = [1, ...encodeU32(body.length), ...body];
  const dataPayload = [
    ...encodeU32(dataSegments.length),
    ...dataSegments.flatMap(({ offset, bytes }) => [
      0,
      0x41,
      ...encodeS32(offset),
      0x0b,
      ...encodeU32(bytes.length),
      ...bytes,
    ]),
  ];
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...section(1, typePayload),
    ...section(2, importPayload),
    ...section(3, functionPayload),
    ...section(5, memoryPayload),
    ...section(7, exportPayload),
    ...section(10, codePayload),
    ...section(11, dataPayload),
  ]));
}

const I32 = 0x7f;
const I64 = 0x7e;
const PATH_OPEN_TYPE = { params: [I32, I32, I32, I32, I32, I64, I64, I32, I32], results: [I32] };
const FD_SEEK_TYPE = { params: [I32, I64, I32, I32], results: [I32] };
const FD_READ_TYPE = { params: [I32, I32, I32, I32], results: [I32] };
const FD_READDIR_TYPE = { params: [I32, I32, I32, I64, I32], results: [I32] };
const PATH_RENAME_TYPE = { params: [I32, I32, I32, I32, I32, I32], results: [I32] };
const PATH_UNLINK_TYPE = { params: [I32, I32, I32], results: [I32] };
const PROC_EXIT_TYPE = { params: [I32], results: [] };

function i32(value) {
  return [0x41, ...encodeS32(value)];
}

function i64(value) {
  let remaining = BigInt(value);
  const bytes = [];
  let more = true;
  while (more) {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    more = !((remaining === 0n && (byte & 0x40) === 0) ||
      (remaining === -1n && (byte & 0x40) !== 0));
    if (more) byte |= 0x80;
    bytes.push(byte);
  }
  return [0x42, ...bytes];
}

function call(index) {
  return [0x10, ...encodeU32(index)];
}

function createHarnessResult(module, tree) {
  const rootDirectory = createMemoryTree(tree);
  const output = [];
  const result = runWasiP1(module, {
    preopens: { "/": rootDirectory },
    stdout: (bytes) => output.push(bytes),
  });
  return { ...result, output: chunksToBytes(output), tree: rootDirectory };
}

function unsupportedImportModule() {
  const encoder = new TextEncoder();
  const moduleName = encoder.encode("wasi_snapshot_preview1");
  const functionName = encoder.encode("fd_sync");
  const typeSection = section(1, [1, 0x60, 0, 0]);
  const importPayload = [
    1,
    ...encodeU32(moduleName.length),
    ...moduleName,
    ...encodeU32(functionName.length),
    ...functionName,
    0,
    0,
  ];
  const importSection = section(2, importPayload);
  return new WebAssembly.Module(new Uint8Array([
    0x00, 0x61, 0x73, 0x6d,
    0x01, 0x00, 0x00, 0x00,
    ...typeSection,
    ...importSection,
  ]));
}

test("WASI preview1 shim rejects imports outside the supported surface", () => {
  const module = unsupportedImportModule();
  const tree = createMemoryTree({ tmp: {} });
  assert.throws(
    () => runWasiP1(module, { preopens: { "/": tree, "/tmp": tree.entries.get("tmp") } }),
    WebAssembly.LinkError,
    "The shim linked an unsupported WASI import",
  );
});

test("memory trees preserve file bytes and nested directories", () => {
  const tree = createMemoryTree({
    src: { "top.v": "module top; endmodule\n" },
    "binary.dat": new Uint8Array([0, 255, 1]),
  });
  const object = treeToObject(tree);
  assert.equal(new TextDecoder().decode(object.src["top.v"]), "module top; endmodule\n");
  assert.deepStrictEqual(object["binary.dat"], new Uint8Array([0, 255, 1]));
  object["binary.dat"][0] = 99;
  assert.equal(tree.entries.get("binary.dat").data[0], 0);
});

for (const board of BOARDS) {
  test(`WASI preview1 matches node:wasi Yosys and nextpnr for ${board.id}`, () => {
    const { files } = createBlinkTemplate(board.id, "verilog");
    const source = files.get("src/top.v");
    const referenceWorkdir = createWorkdir("wasi-p1-reference-");
    const shimWorkTree = makeWorkTree(source, board);
    try {
      writeFileSync(path.join(referenceWorkdir, "src/top.v"), source);
      runYosysWasi(referenceWorkdir, source);
      const referenceYosys = {
        json: readFileSync(path.join(referenceWorkdir, "top.json")),
        stdout: readFileSync(path.join(referenceWorkdir, "yosys.stdout")),
        stderr: readFileSync(path.join(referenceWorkdir, "yosys.stderr")),
      };
      const yosysShare = readTree(yosysSharePath);
      const p1Yosys = runShim(
        yosysModule,
        shimWorkTree,
        yosysShare,
        yosysCommand,
      );
      assert.equal(p1Yosys.exitCode, 0, `Yosys failed for ${board.id}: ${new TextDecoder().decode(p1Yosys.stderr)}`);
      assert.deepStrictEqual(Buffer.from(bytesAt(p1Yosys.tree, "top.json")), referenceYosys.json);
      assert.deepStrictEqual(Buffer.from(p1Yosys.stdout), referenceYosys.stdout);
      assert.deepStrictEqual(Buffer.from(p1Yosys.stderr), referenceYosys.stderr);

      const pnrWorkdir = createWorkdir("wasi-p1-pnr-reference-");
      try {
        writeFileSync(path.join(pnrWorkdir, "top.json"), referenceYosys.json);
        writeFileSync(path.join(pnrWorkdir, "constraints/board.cst"), generateCst(board.id));
        const args = pnrArgs(board);
        const referencePnr = runWasi(
          pnrWorkdir,
          args,
          undefined,
          undefined,
          (memory, _clockId, _precision, pointer) => {
            new DataView(memory.buffer).setBigUint64(pointer, 0n, true);
            return 0;
          },
        );
        assert.equal(referencePnr.status, 0, `Reference nextpnr failed for ${board.id}:\n${referencePnr.stderr}`);
        const pnrTree = makeWorkTree(source, board, referenceYosys.json);
        const p1Pnr = runShim(
          nextpnrModule,
          pnrTree,
          readTree(wasiSharePath),
          ["nextpnr-himbaechel-gowin", ...args],
          () => 0n,
        );
        assert.equal(p1Pnr.exitCode, 0, `nextpnr failed for ${board.id}: ${new TextDecoder().decode(p1Pnr.stderr)}`);
        assert.deepStrictEqual(Buffer.from(bytesAt(p1Pnr.tree, "pnr.json")), readFileSync(path.join(pnrWorkdir, "pnr.json")));
        assert.deepStrictEqual(Buffer.from(p1Pnr.stdout), Buffer.from(referencePnr.stdout));
        assert.deepStrictEqual(Buffer.from(p1Pnr.stderr), Buffer.from(referencePnr.stderr));
        assert.ok(p1Yosys.memoryBytes >= 65_536);
        assert.ok(p1Pnr.memoryBytes >= 65_536);
      } finally {
        rmSync(pnrWorkdir, { recursive: true, force: true });
      }
    } finally {
      rmSync(referenceWorkdir, { recursive: true, force: true });
    }
  });
}

test("WASI preview1 reports Yosys syntax errors with the same line", () => {
  const invalidSource = "module top;\n  assign out = ;\nendmodule\n";
  const board = BOARDS[0];
  const referenceWorkdir = createWorkdir("wasi-p1-syntax-reference-");
  const shimTree = makeWorkTree(invalidSource, board);
  try {
    writeFileSync(path.join(referenceWorkdir, "src/top.v"), invalidSource);
    const reference = runNodeWasi(
      yosysModule,
      referenceWorkdir,
      [...yosysCommand],
      yosysSharePath,
    );
    const actual = runShim(yosysModule, shimTree, readTree(yosysSharePath), yosysCommand);
    assert.notEqual(reference.status, 0);
    assert.equal(actual.exitCode, reference.status);
    const pattern = /(?:line\s+2|top\.v:2\b)/i;
    assert.deepStrictEqual(relevantLines(actual.stderr, pattern), relevantLines(reference.stderr, pattern));
    assert.ok(relevantLines(actual.stderr, pattern).length > 0);
  } finally {
    rmSync(referenceWorkdir, { recursive: true, force: true });
  }
});

test("WASI preview1 reports the same nonexistent-pin failure as node:wasi", () => {
  const board = BOARDS[0];
  const sourceWorkdir = createWorkdir("wasi-p1-pin-reference-");
  const { files } = createBlinkTemplate(board.id, "verilog");
  try {
    runYosysWasi(sourceWorkdir, files.get("src/top.v"));
    writeFileSync(path.join(sourceWorkdir, "constraints/invalid.cst"), 'IO_LOC "led" INVALID_PIN_NAME;\n');
    const args = pnrArgs(board, "constraints/invalid.cst");
    const reference = runWasi(
      sourceWorkdir,
      args,
      undefined,
      undefined,
      (memory, _clockId, _precision, pointer) => {
        new DataView(memory.buffer).setBigUint64(pointer, 0n, true);
        return 0;
      },
    );
    assert.notEqual(reference.status, 0);
    const actual = runShim(
      nextpnrModule,
      {
        src: { "top.v": files.get("src/top.v") },
        constraints: { "invalid.cst": 'IO_LOC "led" INVALID_PIN_NAME;\n' },
        tmp: {},
        "top.json": readFileSync(path.join(sourceWorkdir, "top.json")),
      },
      readTree(wasiSharePath),
      ["nextpnr-himbaechel-gowin", ...args],
      () => 0n,
    );
    assert.equal(actual.exitCode, reference.status);
    const pattern = /pin|constraint|CST/i;
    assert.deepStrictEqual(
      relevantLines(actual.stderr, pattern),
      relevantLines(new TextEncoder().encode(reference.stderr), pattern),
    );
    assert.ok(relevantLines(actual.stderr, pattern).length > 0);
  } finally {
    rmSync(sourceWorkdir, { recursive: true, force: true });
  }
});

test("WASI preview1 errno cases preserve the requested file operations", () => {
  const pathOpen = [
    ...i32(3), ...i32(0), ...i32(100), ...i32(7), ...i32(0),
    ...i64(0), ...i64(0), ...i32(0), ...i32(64), ...call(0), ...call(1),
  ];
  const missingModule = wasmHarness(
    [
      { name: "path_open", type: PATH_OPEN_TYPE },
      { name: "proc_exit", type: PROC_EXIT_TYPE },
    ],
    pathOpen,
    [{ offset: 100, bytes: [...new TextEncoder().encode("missing")] }],
  );
  const missing = createHarnessResult(missingModule, {});
  assert.equal(missing.exitCode, 44, "Opening a missing file must return NOENT");

  const encoder = new TextEncoder();
  const openRelative = (pathname) => {
    const pathBytes = encoder.encode(pathname);
    const module = wasmHarness(
      [
        { name: "path_open", type: PATH_OPEN_TYPE },
        { name: "proc_exit", type: PROC_EXIT_TYPE },
      ],
      [
        ...i32(3), ...i32(0), ...i32(100), ...i32(pathBytes.length), ...i32(0),
        ...i64(0), ...i64(0), ...i32(0), ...i32(64), ...call(0), ...call(1),
      ],
      [{ offset: 100, bytes: [...pathBytes] }],
    );
    return module;
  };
  const parentTraversal = createHarnessResult(
    openRelative("nested/inner/../../target"),
    { nested: { inner: {} }, target: "" },
  );
  assert.equal(parentTraversal.exitCode, 0, "Parent traversal within the preopen must work");
  const escapeTraversal = createHarnessResult(
    openRelative("../target"),
    { target: "" },
  );
  assert.equal(escapeTraversal.exitCode, 76, "Parent traversal must not escape the preopen");

  const seekAndReadModule = wasmHarness(
    [
      { name: "path_open", type: PATH_OPEN_TYPE },
      { name: "fd_seek", type: FD_SEEK_TYPE },
      { name: "fd_read", type: FD_READ_TYPE },
      { name: "proc_exit", type: PROC_EXIT_TYPE },
    ],
    [
      ...i32(3), ...i32(0), ...i32(100), ...i32(4), ...i32(0),
      ...i64(6), ...i64(0), ...i32(0), ...i32(320), ...call(0), 0x1a,
      ...i32(4), ...i64(100), ...i32(0), ...i32(64), ...call(1), 0x1a,
      ...i32(4), ...i32(200), ...i32(1), ...i32(300), ...call(2), 0x1a,
      ...i32(300), 0x28, 2, 0, ...call(3),
    ],
    [
      { offset: 100, bytes: [...new TextEncoder().encode("input")] },
      { offset: 200, bytes: [0, 1, 0, 0, 0, 4, 0, 0, 0] },
    ],
  );
  const seekAndRead = createHarnessResult(seekAndReadModule, { input: "data" });
  assert.equal(seekAndRead.exitCode, 0, "Reading after seeking past EOF must return zero bytes");

  const readdirType = [
    { name: "fd_readdir", type: FD_READDIR_TYPE },
    { name: "proc_exit", type: PROC_EXIT_TYPE },
  ];
  const readdirFirst = wasmHarness(
    readdirType,
    [...i32(3), ...i32(400), ...i32(25), ...i64(0), ...i32(300), ...call(0), 0x1a, ...i32(300), 0x28, 2, 0, ...call(1)],
  );
  const firstPage = createHarnessResult(readdirFirst, { a: "", b: "" });
  assert.equal(firstPage.exitCode, 25, "A small readdir buffer must contain one complete entry");
  const readdirResume = wasmHarness(
    [
      { name: "fd_readdir", type: FD_READDIR_TYPE },
      { name: "fd_write", type: FD_READ_TYPE },
      { name: "proc_exit", type: PROC_EXIT_TYPE },
    ],
    [
      ...i32(3), ...i32(400), ...i32(25), ...i64(0), ...i32(300), ...call(0), 0x1a,
      ...i32(3), ...i32(400), ...i32(26), ...i64(1), ...i32(300), ...call(0), 0x1a,
      ...i32(1), ...i32(200), ...i32(1), ...i32(300), ...call(1), 0x1a,
      ...i32(300), 0x28, 2, 0, ...call(2),
    ],
    [{ offset: 200, bytes: [0xa8, 1, 0, 0, 2, 0, 0, 0] }],
  );
  const resumed = createHarnessResult(readdirResume, { a: "", b: "" });
  assert.equal(resumed.exitCode, 2, "Cookie resume must write the two-byte entry");
  assert.equal(new TextDecoder().decode(resumed.output), "..", "Cookie 1 must resume at the next entry");

  const renameAndUnlinkModule = wasmHarness(
    [
      { name: "path_rename", type: PATH_RENAME_TYPE },
      { name: "path_unlink_file", type: PATH_UNLINK_TYPE },
      { name: "proc_exit", type: PROC_EXIT_TYPE },
    ],
    [
      ...i32(3), ...i32(100), ...i32(3), ...i32(3), ...i32(103), ...i32(3), ...call(0), 0x1a,
      ...i32(3), ...i32(103), ...i32(3), ...call(1), ...call(2),
    ],
    [
      { offset: 100, bytes: [...new TextEncoder().encode("oldnew")] },
    ],
  );
  const renameAndUnlink = createHarnessResult(renameAndUnlinkModule, { old: "payload" });
  assert.equal(renameAndUnlink.exitCode, 0);
  assert.equal(renameAndUnlink.tree.entries.has("old"), false);
  assert.equal(renameAndUnlink.tree.entries.has("new"), false);
});
