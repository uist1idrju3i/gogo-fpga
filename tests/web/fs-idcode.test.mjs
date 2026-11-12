import assert from "node:assert/strict";
import test from "node:test";

import { BOARDS, getBoard } from "../../web/lib/boards.mjs";
import {
  FS_IDCODE_MASK,
  fsIdcode,
  fsIdcodeMatchesBoard,
} from "../../web/lib/fs-idcode.mjs";

function idcodeRecord(idcode) {
  return `00000110${"0".repeat(24)}${idcode.toString(2).padStart(32, "0")}`;
}

test("fsIdcode reads the 32 low bits from the IDCODE header record", () => {
  const idcode = 0x1100481b;
  const text = [
    "/ comment",
    idcodeRecord(idcode),
    "00111011" + "0".repeat(24),
    idcodeRecord(0x0100681b),
  ].join("\r\n");

  assert.equal(fsIdcode(text), idcode);
});

test("fsIdcode returns null when IDCODE is absent or malformed", () => {
  assert.equal(fsIdcode("/ no idcode\r\n"), null);
  assert.equal(fsIdcode(`00000110${"0".repeat(55)}`), null);
  assert.equal(fsIdcode(null), null);
});

test("fs IDCODEs are compared using Gowin's 28-bit mask", () => {
  assert.equal(FS_IDCODE_MASK, 0x0fffffff);
  assert.equal(fsIdcodeMatchesBoard(0x1100481b, getBoard("tangnano9k")), true);
  assert.equal(fsIdcodeMatchesBoard(0x0100681b, getBoard("tangnano9k")), false);
  assert.equal(fsIdcodeMatchesBoard(null, BOARDS[0]), false);
});
