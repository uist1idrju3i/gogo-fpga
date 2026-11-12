import assert from "node:assert/strict";
import test from "node:test";
import { inspectFormalDesign, validateFormalProperties } from "../../web/lib/formal-properties.mjs";

function design({ sequential = false } = {}) {
  const cells = {
    invariant: { type: "$assert", attributes: { src: "src/top.v:4.1-4.20" }, connections: { A: [3], EN: ["1"] } },
    premise: { type: "$assume", attributes: { src: "src/top.v:3.1-3.20" }, connections: { A: [4], EN: ["1"] } },
    reached: { type: "$cover", attributes: { src: "src/top.v:5.1-5.20" }, connections: { A: [5], EN: ["1"] } },
  };
  if (sequential) cells.state = {
    type: "$dff", parameters: { CLK_POLARITY: "0001" }, connections: { CLK: [2] },
  };
  return { modules: { top: { cells, ports: { clk: { direction: "input", bits: [2] } } } } };
}

test("formal inventory retains property identity, source, and all constraint kinds without mutation", () => {
  const before = design();
  const saved = structuredClone(before);
  const inventory = validateFormalProperties(before, structuredClone(before), { top: "top" });
  assert.deepEqual(inventory.counts, { assert: 1, assume: 1, cover: 1 });
  assert.equal(inventory.properties[0].id, "invariant");
  assert.equal(inventory.registers, 0);
  assert.equal(inventory.clock, null);
  assert.deepEqual(before, saved);
});

test("formal preparation rejects lost, renamed, changed, duplicated, or invented properties", () => {
  const mutations = [
    (cells) => { delete cells.invariant; },
    (cells) => { cells.renamed = cells.invariant; delete cells.invariant; },
    (cells) => { cells.invariant.type = "$assume"; },
    (cells) => { cells.invariant.attributes.src = "src/other.v:1"; },
    (cells) => { cells.duplicate = structuredClone(cells.invariant); },
    (cells) => { cells.invariant.attributes = {}; },
    (cells) => { cells.invariant.connections.A = ["x"]; },
    (cells) => { cells.invariant.connections.EN = []; },
    (cells) => { cells.invariant.type = "$check"; },
  ];
  for (const mutate of mutations) {
    const before = design();
    const after = structuredClone(before);
    mutate(after.modules.top.cells);
    assert.throws(() => validateFormalProperties(before, after, { top: "top" }));
  }
});

test("formal validation refuses empty targets and unsupported or malformed designs", () => {
  const empty = design();
  delete empty.modules.top.cells.invariant;
  assert.throws(() => validateFormalProperties(empty, empty, { top: "top" }), /No assertion/);
  for (const document of [null, {}, { modules: [] }, { modules: {} }, { modules: { top: {} } }]) {
    assert.throws(() => inspectFormalDesign(document, "top"));
  }
  for (const type of ["$live", "$fair", "$check", "$adff", "$dlatch", "$ff", "$mem_v2"]) {
    const document = design();
    document.modules.top.cells.unsupported = { type };
    assert.throws(() => inspectFormalDesign(document, "top"));
  }
  const hierarchy = design();
  hierarchy.modules.child = { cells: {}, ports: {} };
  assert.throws(() => inspectFormalDesign(hierarchy, "top"), /flattened/);
  assert.throws(() => validateFormalProperties(design(), design(), { top: "top", mode: "cover" }));
});

test("sequential formal validation requires the same explicit clock and edge on every register", () => {
  const document = design({ sequential: true });
  const config = { top: "top", clock: "clk", edge: "posedge", mode: "prove" };
  assert.equal(validateFormalProperties(document, document, config).registers, 1);
  for (const change of [{ clock: null }, { clock: "missing" }, { clock: "__proto__" }, { edge: "negedge" }, { edge: "any" }]) {
    assert.throws(() => validateFormalProperties(document, document, { ...config, ...change }));
  }
  for (const mutate of [
    (value) => { value.modules.top.ports.clk.bits = [2, 3]; },
    (value) => { value.modules.top.ports.clk.direction = "output"; },
    (value) => { value.modules.top.cells.state.connections.CLK = [4]; },
    (value) => { value.modules.top.cells.state.parameters.CLK_POLARITY = "unknown"; },
    (value) => { value.modules.top.cells.other = { ...value.modules.top.cells.state, connections: { CLK: [4] } }; },
  ]) {
    const invalid = structuredClone(document);
    mutate(invalid);
    assert.throws(() => validateFormalProperties(invalid, invalid, config));
  }
});
