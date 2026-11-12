import assert from "node:assert/strict";
import test from "node:test";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";

function initOnlyModule(formalExit = null) {
  const section = (id, content) => [id, content.length, ...content];
  const name = (value) => [value.length, ...Buffer.from(value)];
  const count = formalExit === null ? 2 : 3;
  const exports = [
    ...name("memory"), 2, 0,
    ...name("synth_api__synth_set_std"), 0, 0,
    ...name("synth_api__synth_init"), 0, 1,
    ...name("__wasm_call_ctors"), 0, 1,
    ...(formalExit === null ? [] : [...name("synth_api__synth_set_formal"), 0, 2]),
  ];
  return new WebAssembly.Module(Uint8Array.from([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [3, 96, 1, 127, 1, 127, 96, 0, 1, 127, 96, 2, 127, 127, 1, 127]),
    ...section(3, [count, 0, 1, ...(formalExit === null ? [] : [2])]),
    ...section(5, [1, 0, 1]),
    ...section(7, [count + 2, ...exports]),
    ...section(10, [count, 4, 0, 65, 0, 11, 4, 0, 65, 0, 11,
      ...(formalExit === null ? [] : [4, 0, 65, formalExit, 11])]),
  ]));
}

test("GHDL requires boolean formal settings and explicit PSL opt-in", () => {
  for (const settings of [
    { formal: 1 }, { formal: "true" }, { formal: null },
    { psl: 1 }, { psl: "true" }, { psl: null }, { psl: true },
  ]) assert.throws(() => runGhdlSynth(settings), /Invalid GHDL formal or PSL setting/);
});

test("a legacy GHDL module cannot silently ignore requested formal or PSL settings", () => {
  for (const psl of [false, true]) {
    const result = runGhdlSynth({ module: initOnlyModule(), librariesTree: {}, files: [], top: "top", formal: true, psl });
    assert.equal(result.status, -1);
    assert.equal(result.stage, "init");
    assert.equal(result.verilog, "");
    assert.match(result.log, /does not support formal or PSL/);
  }
});

test("GHDL setting failure stops before analyzing or emitting a circuit", () => {
  const result = runGhdlSynth({ module: initOnlyModule(1), librariesTree: {}, files: [], top: "top", formal: true });
  assert.equal(result.status, -1);
  assert.equal(result.stage, "init");
  assert.equal(result.verilog, "");
  assert.match(result.log, /rejected formal or PSL/);
});
