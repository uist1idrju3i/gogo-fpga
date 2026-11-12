import assert from "node:assert/strict";
import test from "node:test";
import { bindLoweredProperties } from "./ghdl-lowered-replay.mjs";

function fixture() {
  const design = (id, source) => ({ modules: { top: {
    ports: { a: { direction: "input", bits: [2] }, q: { direction: "output", bits: [3] } },
    netnames: { condition: { bits: [4] } },
    cells: { [id]: { type: "$assert", connections: { A: [4], EN: ["1"] }, attributes: { src: source } } },
  } } });
  return { replay: { locations: [{ id: "p_bound" }] },
    original: design("p_bound", "top.vhd:14.3-14.3"), emitted: design("new", "top.v:22.3-22.8") };
}
const bind = ({ replay, original, emitted }) => bindLoweredProperties(replay, original, emitted, { top: "top", clock: null });

test("lowered properties bind by kind and A/EN aliases, not property order", () => {
  const value = fixture();
  const result = bind(value);
  assert.equal(result.locations[0].id, "p_bound");
  assert.equal(result.locations[0].source, "top.vhd:14.3-14.3");
  assert.equal(result.locations[0].path, "top.v");
  assert.equal(result.locations[0].line, 22);
  assert.equal(result.locations[0].emittedId, "new");
  assert.deepEqual(value.replay, { locations: [{ id: "p_bound" }] });
});

test("lowered state bits preserve identity, width and initialization", () => {
  const value = fixture();
  for (const document of [value.original, value.emitted]) {
    const module = document.modules.top;
    module.netnames.state = { bits: [5, 6], attributes: { init: "01" } };
    module.cells.state = { type: "$dff", parameters: { CLK_POLARITY: "1" }, connections: { CLK: [2], Q: [5, 6], D: [3, 3] } };
  }
  const bindState = (x) => bindLoweredProperties(x.replay, x.original, x.emitted, { top: "top", clock: "a" });
  assert.equal(bindState(value).mappings.length, 1);
  for (const mutate of [
    (module) => { module.cells.state.connections.Q.pop(); },
    (module) => { module.netnames.state.attributes.init = "00"; },
    (module) => { module.netnames.other = module.netnames.state; delete module.netnames.state; },
  ]) {
    const changed = structuredClone(value);
    mutate(changed.emitted.modules.top);
    assert.throws(() => bindState(changed), /Lowered state/);
  }
});

for (const [name, mutate, expected] of [
  ["renamed connection", (x) => { x.emitted.modules.top.netnames = { other: { bits: [4] } }; }, /mapping/],
  ["changed enable", (x) => { x.emitted.modules.top.cells.new.connections.EN = ["0"]; }, /mapping/],
  ["extra property", (x) => { x.emitted.modules.top.cells.extra = structuredClone(x.emitted.modules.top.cells.new); }, /inventory/],
  ["changed kind", (x) => { x.emitted.modules.top.cells.new.type = "$assume"; }, /No assertion|inventory/],
  ["changed port direction", (x) => { x.emitted.modules.top.ports.q.direction = "input"; }, /port inventory/],
  ["changed port width", (x) => { x.emitted.modules.top.ports.q.bits.push(5); }, /port inventory/],
  ["missing replay location", (x) => { x.replay.locations = []; }, /Incomplete/],
  ["invalid source", (x) => { x.emitted.modules.top.cells.new.attributes.src = "missing"; }, /source location/],
]) test(`lowered binding rejects ${name}`, () => {
  const value = fixture();
  mutate(value);
  assert.throws(() => bind(value), expected);
});

test("lowered binding rejects ambiguous matching properties", () => {
  const value = fixture();
  value.original.modules.top.cells.second = structuredClone(value.original.modules.top.cells.p_bound);
  value.emitted.modules.top.cells.second = structuredClone(value.emitted.modules.top.cells.new);
  value.replay.locations.push({ id: "second" });
  assert.throws(() => bind(value), /Ambiguous/);
});

test("cover omission is explicit and limited to the Icarus assertion replay model", () => {
  const value = fixture();
  value.original.modules.top.cells.cover = { ...structuredClone(value.original.modules.top.cells.p_bound), type: "$cover" };
  assert.equal(bind(value).omittedCovers.length, 1);
  value.emitted.modules.top.cells.cover = { ...structuredClone(value.emitted.modules.top.cells.new), type: "$cover" };
  assert.throws(() => bind(value), /cover statements/);
});
