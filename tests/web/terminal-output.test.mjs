import assert from "node:assert/strict";
import test from "node:test";

import { writeTerminalText } from "../../web/lib/terminal-output.mjs";

test("writeTerminalText replaces the current line after a carriage return", () => {
  let state = { text: "" };
  state = writeTerminalText(state, "Parse file /fixture.fs:");
  state = writeTerminalText(state, "\rParse /input.fs:\n");

  assert.equal(state.text, "Parse /input.fs:\n");
});

test("writeTerminalText keeps progress redraws on one line", () => {
  let state = { text: "" };
  state = writeTerminalText(state, "Erasing FLASH: 12%\r");
  state = writeTerminalText(state, "Erasing FLASH: 60%\r");
  state = writeTerminalText(state, "Erasing FLASH: 100%\nDone\n");

  assert.equal(state.text, "Erasing FLASH: 100%\nDone\n");
});

test("writeTerminalText preserves completed lines", () => {
  const state = writeTerminalText(
    { text: "" },
    "Load SRAM\nParse /input.fs:\n",
  );

  assert.equal(state.text, "Load SRAM\nParse /input.fs:\n");
});
