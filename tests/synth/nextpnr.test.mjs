import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BOARDS } from "../../web/lib/boards.mjs";
import { createBlinkTemplate, generateCst, TEMPLATE_PINS } from "../../web/lib/templates.mjs";
import {
  chipdbPath,
  createWorkdir,
  nativeChipdbPath,
  nextpnrWasmPath,
  pnrArgs,
  runNative,
  runWasi,
  runYosysWasi,
  wasiSharePath,
  yosysWasmPath,
} from "./nextpnr-helpers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const boardsById = new Map(BOARDS.map((board) => [board.id, board]));
const boardIds = Object.keys(TEMPLATE_PINS);

function assertKeyOrderEqual(expected, actual, jsonPath = "$") {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
      assertKeyOrderEqual(expected[index], actual[index], `${jsonPath}[${index}]`);
    }
    return;
  }
  if (
    expected === null ||
    actual === null ||
    typeof expected !== "object" ||
    typeof actual !== "object"
  ) {
    return;
  }
  const expectedKeys = Object.keys(expected);
  const actualKeys = Object.keys(actual);
  assert.deepStrictEqual(actualKeys, expectedKeys, `JSON key order differs at ${jsonPath}`);
  for (const key of expectedKeys) {
    assertKeyOrderEqual(expected[key], actual[key], `${jsonPath}.${key}`);
  }
}

function comparePnrDocuments(nativeDocument, wasiDocument) {
  assertKeyOrderEqual(nativeDocument, wasiDocument);
  assert.deepStrictEqual(nativeDocument, wasiDocument);
}

function mutateCellType(document) {
  for (const module of Object.values(document.modules ?? {})) {
    const cell = Object.values(module.cells ?? {})[0];
    if (cell) {
      cell.type = `${cell.type}_MUTATED`;
      return true;
    }
  }
  return false;
}

function assertSuccessful(result, runtime, boardId) {
  assert.equal(result.status, 0, `${runtime} P&R failed for ${boardId}:\n${result.stderr}\n${result.error ?? ""}`);
}

const chipdbNames = readdirSync(chipdbPath).filter((name) => name.endsWith(".bin")).sort();
const expectedChipdbNames = BOARDS.map((board) => `chipdb-${board.nextpnrFamily}.bin`).sort();
assert.deepStrictEqual(chipdbNames, expectedChipdbNames, "Gowin chipdb set does not match boards");
assert.deepStrictEqual(
  readdirSync(nativeChipdbPath).filter((name) => name.endsWith(".bin")).sort(),
  expectedChipdbNames,
  "Native Gowin chipdb set does not match boards",
);
for (const name of expectedChipdbNames) {
  assert.deepStrictEqual(
    readFileSync(path.join(nativeChipdbPath, name)),
    readFileSync(path.join(chipdbPath, name)),
    `Native and WASI chipdb data differs: ${name}`,
  );
}
console.log(
  `nextpnr WASM: ${statSync(nextpnrWasmPath).size} bytes; ` +
    `chipdb: ${chipdbNames.map((name) => `${name}=${statSync(path.join(chipdbPath, name)).size}`).join(", ")}`,
);

for (const boardId of boardIds) {
  test(`nextpnr WASI and native match for ${boardId}`, () => {
    const board = boardsById.get(boardId);
    assert.ok(board, `Board definition is missing: ${boardId}`);
    const workdir = createWorkdir();
    const nativeWorkdir = createWorkdir();
    const wasiWorkdir = createWorkdir();
    try {
      const { files } = createBlinkTemplate(boardId, "verilog");
      const source = files.get("src/top.v");
      assert.equal(typeof source, "string", `${boardId} Verilog template is missing`);
      runYosysWasi(workdir, source);
      const jsonPath = path.join(workdir, "top.json");
      const cst = generateCst(boardId);
      for (const target of [nativeWorkdir, wasiWorkdir]) {
        writeFileSync(path.join(target, "top.json"), readFileSync(jsonPath));
        writeFileSync(path.join(target, "constraints/board.cst"), cst);
      }
      const args = pnrArgs(board);
      const native = runNative(nativeWorkdir, args);
      const wasi = runWasi(wasiWorkdir, args);
      assertSuccessful(native, "native", boardId);
      assertSuccessful(wasi, "WASI", boardId);
      const nativeDocument = JSON.parse(readFileSync(path.join(nativeWorkdir, "pnr.json"), "utf8"));
      const wasiDocument = JSON.parse(readFileSync(path.join(wasiWorkdir, "pnr.json"), "utf8"));
      comparePnrDocuments(nativeDocument, wasiDocument);
      if (boardId === boardIds[0]) {
        const mutated = structuredClone(wasiDocument);
        assert.ok(mutateCellType(mutated), "No P&R cell was available for negative control");
        assert.throws(
          () => comparePnrDocuments(nativeDocument, mutated),
          assert.AssertionError,
          "P&R comparison accepted a changed cell type",
        );
      }
      console.log(
        `${boardId}: native ${native.elapsed.toFixed(1)} ms; ` +
          `WASI ${wasi.elapsed.toFixed(1)} ms; ` +
          `process peak RSS ${process.resourceUsage().maxRSS} KiB`,
      );
    } finally {
      rmSync(workdir, { recursive: true, force: true });
      rmSync(nativeWorkdir, { recursive: true, force: true });
      rmSync(wasiWorkdir, { recursive: true, force: true });
    }
  });
}

test("invalid pin and missing chipdb fail closed", () => {
  const board = boardsById.get(boardIds[0]);
  const workdir = createWorkdir();
  const emptyChipdb = mkdtempSync(path.join(os.tmpdir(), "nextpnr-empty-chipdb-"));
  try {
    const { files } = createBlinkTemplate(board.id, "verilog");
    runYosysWasi(workdir, files.get("src/top.v"));
    writeFileSync(path.join(workdir, "constraints/board.cst"), generateCst(board.id));
    const invalidCst = "IO_LOC \"led\" INVALID_PIN_NAME;\n";
    writeFileSync(path.join(workdir, "constraints/invalid.cst"), invalidCst);
    const invalidArgs = pnrArgs(board, "constraints/invalid.cst");
    for (const [runtime, result] of [
      ["native", runNative(workdir, invalidArgs)],
      ["WASI", runWasi(workdir, invalidArgs)],
    ]) {
      assert.notEqual(result.status, 0, `${runtime} accepted a nonexistent pin`);
      assert.match(
        `${result.stderr}\n${result.stdout}`,
        /pin|CST|constraint/i,
        `${runtime} omitted a useful pin error:\n${result.stderr}\n${result.stdout}`,
      );
    }
    const missing = runWasi(workdir, pnrArgs(board), emptyChipdb);
    assert.notEqual(missing.status, 0, "WASI nextpnr accepted a missing chipdb");
    console.log(
      `WASI module size ${statSync(nextpnrWasmPath).size} bytes; ` +
        `chipdb files ${readdirSync(path.join(wasiSharePath, "himbaechel/gowin")).length}; ` +
        `sum ${readdirSync(path.join(wasiSharePath, "himbaechel/gowin")).reduce((sum, file) => sum + statSync(path.join(wasiSharePath, "himbaechel/gowin", file)).size, 0)} bytes`,
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(emptyChipdb, { recursive: true, force: true });
  }
});
