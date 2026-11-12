import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { assertYosysCreator, assertYosysParity, creatorPrefix, nativeYosysSharePath } from "./yosys-parity.mjs";

function documents() {
  const native = {
    creator: `${creatorPrefix}, native compiler)`,
    modules: { top: { cells: { gate: {
      type: "LUT4", parameters: { INIT: "0110" },
      attributes: { src: `${nativeYosysSharePath}/gowin/cells_sim.v:1` },
    } } } },
  };
  const wasi = structuredClone(native);
  wasi.creator = `${creatorPrefix}, WASI compiler)`;
  wasi.modules.top.cells.gate.attributes.src = "/share/gowin/cells_sim.v:1";
  return { native, wasi };
}

test("Yosys parity only normalizes compiler identity and share source attributes", () => {
  const { native, wasi } = documents();
  const before = structuredClone({ native, wasi });
  assertYosysParity(native, wasi);
  assert.deepEqual({ native, wasi }, before);
});

test("Yosys creator accepts pinned shallow and archive metadata without accepting other revisions", () => {
  const commit = execFileSync("git", ["rev-parse", "HEAD:vendor/yosys"], { encoding: "utf8" }).trim();
  const prefix = creatorPrefix.replace(commit.slice(0, 9), commit);
  for (const base of [creatorPrefix, prefix]) {
    for (const suffix of ["", "+", "+post"]) {
      const creator = `${base.replace(" (git", `${suffix} (git`)}, native compiler)`;
      assertYosysCreator(creator);
      const { native, wasi } = documents();
      native.creator = creator;
      assertYosysParity(native, wasi);
    }
  }
  for (const creator of [
    `${creatorPrefix}-dirty, compiler)`, `${creatorPrefix}0, compiler)`,
    `${creatorPrefix.replace(" (git", "+1 (git")}, compiler)`,
    `${creatorPrefix.replace(" (git", "0 (git")}, compiler)`,
    `${creatorPrefix.replace(commit.slice(0, 9), "000000000")}, compiler)`,
    `${prefix.replace(commit, `${commit.slice(0, -1)}${commit.endsWith("0") ? "1" : "0"}`)}, compiler)`,
    null, undefined,
  ]) assert.throws(() => assertYosysCreator(creator), assert.AssertionError);
});

test("Yosys parity rejects changed circuit, key order, version, and unrelated paths", () => {
  const mutations = [
    (value) => { value.modules.top.cells.gate.parameters.INIT = "1111"; },
    (value) => { value.modules.top.cells.gate.type = "LUT3"; },
    (value) => { value.modules.top.cells.gate = Object.fromEntries(Object.entries(value.modules.top.cells.gate).reverse()); },
    (value) => { value.creator = "unverified Yosys"; },
    (value) => { value.modules.top.cells.gate.parameters.INIT = nativeYosysSharePath; },
  ];
  for (const mutate of mutations) {
    const { native, wasi } = documents();
    mutate(wasi);
    assert.throws(() => assertYosysParity(native, wasi), assert.AssertionError);
  }
});
