import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSmtbmcTestbench } from "../synth/formal-trace-compare.mjs";

test("SMTBMC comparison permits only PI declaration and named connection ordering", () => {
  const original = "  reg [0:0] PI_rst;\n  wire [0:0] PI_clk = clock;\n  top UUT (\n    .rst(PI_rst),\n    .clk(PI_clk)\n  );\n  initial PI_rst = 0;\n";
  const reordered = "  wire [0:0] PI_clk = clock;\n  reg [0:0] PI_rst;\n  top UUT (\n    .clk(PI_clk),\n    .rst(PI_rst)\n  );\n  initial PI_rst = 0;\n";
  assert.equal(normalizeSmtbmcTestbench(original), normalizeSmtbmcTestbench(reordered));
  for (const changed of [original.replace(".rst(PI_rst)", ".rst(PI_clk)"), original.replace("= 0", "= 1"),
    original.replace("[0:0] PI_rst", "[1:0] PI_rst"), original.replace("PI_clk = clock", "PI_clk = 1'b0")]) {
    assert.notEqual(normalizeSmtbmcTestbench(original), normalizeSmtbmcTestbench(changed));
  }
});
