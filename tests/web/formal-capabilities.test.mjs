import assert from "node:assert/strict";
import test from "node:test";
import { FORMAL_SOLVERS, FORMAL_ENGINES, formalCapabilities } from "../../web/lib/formal-capabilities.mjs";

test("all candidates remain visible and disabled until distribution assets are available", () => {
  const { solvers, engines } = formalCapabilities();
  assert.equal(solvers.length, 9);
  assert.equal(engines.filter(entry => entry.kind === "sby").length, 6);
  assert.equal(engines.filter(entry => entry.kind === "builtin").length, 1);
  assert.ok([...solvers, ...engines].every(entry => entry.disabled && entry.reason.length > 0));
  assert.equal(FORMAL_SOLVERS.find(entry => entry.id === "yices2").smtbmc, "yices");
  assert.equal(FORMAL_SOLVERS.find(entry => entry.id === "yices2").command, "yices-smt2");
});

test("asset presence cannot enable unverified, deprecated, diagnostic or model-only candidates", () => {
  const { solvers, engines } = formalCapabilities({
    availableSolvers: FORMAL_SOLVERS.map(entry => entry.id),
    availableEngines: FORMAL_ENGINES.map(entry => entry.id),
  });
  assert.deepEqual(solvers.filter(entry => !entry.disabled).map(entry => entry.id), ["yices2", "z3"]);
  assert.deepEqual(engines.filter(entry => !entry.disabled).map(entry => entry.id), ["smtbmc", "yosys-sat"]);
  assert.equal(solvers.find(entry => entry.id === "boolector").deprecated, true);
  assert.ok(solvers.find(entry => entry.id === "bitwuzla").blockers.includes("product-qualification-missing"));
});

test("qualified diagnostic solvers stay disabled in every mode even when assets are claimed", () => {
  for (const mode of ["bmc", "prove", "cover", "live"]) {
    const { solvers } = formalCapabilities({ mode, availableSolvers: ["bitwuzla", "boolector"] });
    for (const id of ["bitwuzla", "boolector"]) {
      const entry = solvers.find(candidate => candidate.id === id);
      assert.equal(entry.status, "product-unqualified");
      assert.equal(entry.disabled, true);
      assert.deepEqual(entry.modes, []);
      assert.ok(entry.blockers.includes("dependency-distribution-unreviewed"));
      assert.ok(!entry.blockers.includes("help-adapter-missing") && !entry.blockers.includes("build-unverified"));
    }
  }
});

test("mode and solver prerequisites independently restrict the available engines", () => {
  const availableEngines = ["smtbmc", "yosys-sat"];
  assert.ok(formalCapabilities({ availableEngines }).engines.find(entry => entry.id === "smtbmc").disabled);
  for (const mode of ["bmc", "prove", "cover"]) {
    const { engines } = formalCapabilities({ mode, availableEngines, availableSolvers: ["z3"] });
    assert.equal(engines.find(entry => entry.id === "smtbmc").disabled, false);
    assert.equal(engines.find(entry => entry.id === "yosys-sat").disabled, mode === "cover");
  }
  const live = formalCapabilities({ mode: "live", availableEngines, availableSolvers: ["yices2", "z3"] });
  assert.ok([...live.solvers, ...live.engines].every(entry => entry.disabled));
});

test("unknown modes, aliases, malformed availability and duplicate identities fail closed", () => {
  for (const config of [{ mode: "unknown" }, { availableSolvers: ["yices"] }, { availableSolvers: ["unknown"] },
    { availableEngines: ["unknown"] }, { availableSolvers: ["z3", "z3"] }, { availableEngines: ["smtbmc", "smtbmc"] },
    { availableSolvers: null }, { availableEngines: "smtbmc" }, { availableSolvers: [{}] },
    { availableSolvers: new Array(1) }, { availableEngines: new Array(1) },
    { availableSolvers: new Array(FORMAL_SOLVERS.length + 1) }]) {
    assert.throws(() => formalCapabilities(config));
  }
});

test("callers cannot mutate canonical modes, blockers or the next capability result", () => {
  for (const catalog of [FORMAL_SOLVERS, FORMAL_ENGINES]) {
    assert.ok(Object.isFrozen(catalog));
    for (const entry of catalog) {
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.modes) && Object.isFrozen(entry.blockers));
    }
  }
  const result = formalCapabilities();
  result.solvers[0].status = "changed";
  result.engines.length = 0;
  assert.equal(formalCapabilities().solvers[0].status, "probe-verified");
  assert.equal(formalCapabilities().engines.length, 7);
});
