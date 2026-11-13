import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { CPU_CASES } from "../tests/fixtures/cpus/cases.mjs";
import { HDL_LIBRARY_CASES } from "../tests/fixtures/libraries/cases.mjs";
import { BOARDS } from "../web/lib/boards.mjs";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const plan = JSON.parse(readFileSync(new URL("../tests/ci-shards.json", import.meta.url)));
export const packFiles = ["gowin-pack", "library-components", "yosys-parity", "library-measurements"]
  .map((name) => `tests/synth/${name}.test.mjs`);
export const containers = [
  "pinned HDL libraries build from portable ZIP into all four board bitstreams",
  "pinned CPU libraries retain execution and classify all four board builds",
  "eight pinned HDL representatives execute independent scoreboards after portable ZIP import",
];

export function exactPartition(groups, full) {
  assert.ok(Array.isArray(groups) && groups.length && groups.every((group) => Array.isArray(group) && group.length));
  const entries = groups.flat();
  assert.equal(new Set(entries).size, entries.length, "Duplicate shard assignment");
  assert.deepEqual([...entries].sort(), [...full].sort(), "Incomplete shard assignment");
}

exactPartition(plan.cpu, CPU_CASES.map(({ id }) => id));
exactPartition(plan.hdl, BOARDS.map(({ id }) => id));
exactPartition(plan.e2e, readdirSync(path.join(root, "tests/e2e")).filter((name) => name.endsWith(".spec.mjs")));
assert.equal(plan.cpu.length, 4);
assert.equal(plan.hdl.length, 2);
assert.equal(plan.e2e.length, 2);
export const packShards = ["cpu-1", "cpu-2", "cpu-3", "cpu-4", "hdl-1", "hdl-2"];

export function parsePackShard(value) {
  assert.ok(packShards.includes(value), `Invalid pack shard: ${value}`);
  return value;
}

export function matrixAssignment(cpu, id, board) {
  const groups = cpu ? plan.cpu : plan.hdl;
  const index = groups.findIndex((group) => group.includes(cpu ? id : board));
  assert.notEqual(index, -1, `Unassigned matrix case: ${id}/${board}`);
  return `${cpu ? "cpu" : "hdl"}-${index + 1}`;
}

export function leaves(file, name) {
  if (name === containers[0] || name === containers[1]) {
    const cpu = name === containers[1];
    return (cpu ? CPU_CASES : HDL_LIBRARY_CASES).flatMap(({ id }) => BOARDS.map((board) => ({
      name: `${id}/${board.id}`, file, shard: matrixAssignment(cpu, id, board.id),
    })));
  }
  return (name === containers[2] ? HDL_LIBRARY_CASES.map(({ id }) => id) : [name])
    .map((leaf) => ({ name: leaf, file, shard: "hdl-1" }));
}

export function expectedMatrix() {
  return [0, 1].flatMap((index) => leaves(packFiles[0], containers[index]));
}
