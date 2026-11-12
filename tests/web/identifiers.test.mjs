import assert from "node:assert/strict";
import test from "node:test";
import { collectIdentifiers } from "../../web/lib/hdl-keywords.mjs";

test("collectIdentifiers deduplicates identifiers and excludes HDL keywords", () => {
  const identifiers = collectIdentifiers([
    "module top; wire data_bus; integer count1; force signal$1;",
    "module top; always @(posedge clk) data_bus <= count1;",
    "entity design is end entity;",
  ]);

  assert.deepEqual(identifiers, ["clk", "count1", "data_bus", "signal$1", "top"]);
});

test("collectIdentifiers accepts a map of file contents", () => {
  assert.deepEqual(
    collectIdentifiers(
      new Map([
        ["src/top.v", "module top; wire ready;"],
        ["src/top.vhd", "entity top is port (done : out bit);"],
      ]),
    ),
    ["done", "ready", "top"],
  );
});
