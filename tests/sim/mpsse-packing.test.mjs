import assert from "node:assert/strict";
import { test } from "./sharding.mjs";

import { packMpsseBitModeRead } from "./fake-webusb.mjs";

test("packs a three-bit LSB-first MPSSE read into bits 5 through 7", () => {
  assert.equal(packMpsseBitModeRead([1, 0, 1]), 0b10100000);
});

test("packs a seven-bit LSB-first MPSSE read into bits 1 through 7", () => {
  assert.equal(packMpsseBitModeRead([1, 0, 1, 1, 0, 0, 1]), 0b10011010);
});

test("packs an MSB-first MPSSE read into the low bits", () => {
  assert.equal(packMpsseBitModeRead([1, 0, 1], false), 0b00000101);
});

test("rejects MPSSE bit-mode reads longer than one byte", () => {
  assert.throws(() => packMpsseBitModeRead(Array(9).fill(1)), RangeError);
});
