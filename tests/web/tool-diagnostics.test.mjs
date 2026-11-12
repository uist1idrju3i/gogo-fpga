import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseToolDiagnostics } from "../../web/lib/tool-diagnostics.mjs";

const fixtureDirectory = resolve(import.meta.dirname, "../fixtures");

function readFixture(name) {
  return readFileSync(resolve(fixtureDirectory, name), "utf8");
}

test("parses source locations and tool errors into editor diagnostics", () => {
  assert.deepEqual(
    parseToolDiagnostics(
      "ghdl",
      "src/top.vhd:9:3: error: no declaration for \"missing\"",
    ),
    [{
      file: "src/top.vhd",
      line: 9,
      column: 3,
      severity: "error",
      message: 'error: no declaration for "missing"',
    }],
  );
  assert.deepEqual(
    parseToolDiagnostics("yosys", "src/top.v:7:12: ERROR: syntax error, unexpected end of file"),
    [{
      file: "src/top.v",
      line: 7,
      column: 12,
      severity: "error",
      message: "ERROR: syntax error, unexpected end of file",
    }],
  );
  assert.deepEqual(
    parseToolDiagnostics("nextpnr", "constraints/board.cst:4: ERROR: nonexistent pin"),
    [{
      file: "constraints/board.cst",
      line: 4,
      severity: "error",
      message: "ERROR: nonexistent pin",
    }],
  );
  assert.deepEqual(
    parseToolDiagnostics("gowin_pack", "ERROR: Could not find routed netlist"),
    [{
      file: null,
      severity: "error",
      message: "ERROR: Could not find routed netlist",
    }],
  );
  assert.deepEqual(
    parseToolDiagnostics("ivl", "/work/src/top.v:12: syntax error"),
    [{
      file: "src/top.v",
      line: 12,
      severity: "error",
      message: "syntax error",
    }],
  );
  assert.deepEqual(
    parseToolDiagnostics("vvp", "work/sim/top_tb.v:4: warning: ignored"),
    [{
      file: "sim/top_tb.v",
      line: 4,
      severity: "warning",
      message: "warning: ignored",
    }],
  );
});

test("parses diagnostics from captured tool stderr", () => {
  const yosys = parseToolDiagnostics(
    "yosys",
    readFixture("wasi-yosys-syntax.stderr"),
  );
  assert.ok(yosys.some((diagnostic) =>
    diagnostic.file === "src/top.v" &&
    diagnostic.line === 2 &&
    diagnostic.message.includes("syntax error")
  ));

  const nextpnr = parseToolDiagnostics(
    "nextpnr",
    readFixture("wasi-nextpnr-nonexistent-pin.stderr"),
  );
  assert.ok(nextpnr.some((diagnostic) =>
    diagnostic.message.includes("Pin INVALID_PIN_NAME not found")
  ));

  const gowinPack = parseToolDiagnostics(
    "gowin_pack",
    readFixture("pyodide-gowin-pack-failure.stderr"),
  );
  assert.ok(gowinPack.some((diagnostic) =>
    diagnostic.message.includes("JSONDecodeError: Expecting value")
  ));
});

test("rejects unknown diagnostic tools", () => {
  assert.throws(() => parseToolDiagnostics("unknown", "ERROR: failed"), TypeError);
});
