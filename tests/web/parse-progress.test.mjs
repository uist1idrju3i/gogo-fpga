import assert from "node:assert/strict";
import test from "node:test";

import { parseProgress } from "../../web/lib/parse-progress.mjs";

test("parseProgress reads percentages from openFPGALoader progress output", () => {
  assert.equal(parseProgress("Load SRAM: [=====     ] 42.00%"), 42);
  assert.equal(parseProgress("\rErasing FLASH: [===       ] 30.5%\r"), 30.5);
});

test("parseProgress returns the latest bounded value and handles absent data", () => {
  assert.equal(parseProgress("Writing: [==] 10%\rWriting: [====] 25%"), 25);
  assert.equal(parseProgress("Done"), null);
  assert.equal(parseProgress(null), null);
});
