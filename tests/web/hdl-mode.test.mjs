import assert from "node:assert/strict";
import test from "node:test";
import { StringStream } from "@codemirror/language";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import { wrapVhdlMode } from "../../web/lib/hdl-mode.mjs";

const wrappedVhdlMode = wrapVhdlMode(vhdl);

function tokenize(word) {
  const stream = new StringStream(word, 4);
  const style = wrappedVhdlMode.token(stream, wrappedVhdlMode.startState(2));
  return { style, current: stream.current() };
}

test("VHDL extension keywords are highlighted without changing consumed text", () => {
  for (const word of ["force", "release", "protected", "FORCE", "Release"]) {
    assert.deepEqual(tokenize(word), {
      style: "keyword",
      current: word,
    });
  }
});

test("ordinary VHDL identifiers keep their original token style", () => {
  assert.deepEqual(tokenize("ordinary_identifier"), {
    style: "variable",
    current: "ordinary_identifier",
  });
});
