import assert from "node:assert/strict";
import test from "node:test";
import {
  createMemoryTree,
  setTreeEntry,
  treeToObject,
} from "../../web/lib/wasi-p1.mjs";
import { runGhdlSynth } from "../../web/lib/ghdl-host.mjs";
import { runIverilog } from "../../web/lib/iverilog-host.mjs";

const prototypeNames = ["__proto__", "constructor", "prototype", "toString"];

test("memory tree entries preserve prototype member names as own data", () => {
  const tree = {};
  const data = Uint8Array.of(1, 2, 3);
  for (const name of prototypeNames) setTreeEntry(tree, name, data);
  const result = treeToObject(createMemoryTree(tree));
  assert.equal(Object.getPrototypeOf(tree), Object.prototype);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  for (const name of prototypeNames) {
    assert.equal(Object.hasOwn(result, name), true);
    assert.deepEqual(result[name], data);
    assert.notEqual(result[name], data);
  }
});

test("nested memory tree directories do not become JavaScript prototypes", () => {
  const tree = JSON.parse('{"__proto__":{"constructor":{"toString":"rtl"}}}');
  const result = treeToObject(createMemoryTree(tree));
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(Object.hasOwn(result.__proto__, "constructor"), true);
  assert.equal(Object.hasOwn(result.__proto__.constructor, "toString"), true);
  assert.deepEqual(result.__proto__.constructor.toString, new TextEncoder().encode("rtl"));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.__proto__), Object.prototype);
});

for (const [label, invoke, extension] of [
  ["Icarus", (files) => runIverilog({
    modules: { ivlpp: {}, ivl: {}, vvp: {} }, files, top: "top",
  }), "v"],
  ["GHDL", (files) => runGhdlSynth({
    module: {}, librariesTree: {}, files, top: "top",
  }), "vhd"],
]) {
  test(`${label} input paths remain isolated before WASM initialization`, () => {
    const filename = `memory-tree-probe.${extension}`;
    assert.equal(Object.hasOwn(Object.prototype, filename), false);
    const before = Object.getOwnPropertyDescriptors(Object.prototype);
    try {
      for (const name of prototypeNames) {
        assert.throws(() => invoke([{
          path: `${name}/${filename}`,
          content: Uint8Array.of(1),
        }]), /WebAssembly\.Instance/);
        assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
      }
    } finally {
      delete Object.prototype[filename];
    }
  });
}
