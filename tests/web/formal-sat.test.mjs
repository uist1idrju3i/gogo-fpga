import assert from "node:assert/strict";
import test from "node:test";
import { createSatScripts, runSatFormal } from "../../web/lib/formal-sat.mjs";

const config = { sources: ["src/top.v"], top: "top", depth: 4 };
const document = { modules: { top: { ports: {}, cells: {
  invariant: { type: "$assert", attributes: { src: "src/top.v:1" }, connections: { A: [2], EN: ["1"] } },
} } } };

function execution({ presat = "SAT solving finished - model found:\n", proof = "SAT proof finished - no model found: SUCCESS!\n", exitCode = 0, mutate = () => {} } = {}) {
  const phases = [];
  return { phases, execute: async ({ phase }) => {
    phases.push(phase);
    const result = { exitCode: phase === "proof" ? exitCode : 0, stdout: phase === "presat" ? presat : phase === "proof" ? proof : "", stderr: "", files: new Map([
      ["__formal/before.json", JSON.stringify(document)], ["__formal/after.json", JSON.stringify(document)],
      ["__formal/witness.json", JSON.stringify({ signal: [{ name: "a", wave: "1" }] })],
      ["__formal/witness.vcd", "$enddefinitions $end\n#0\n1!\n"],
    ]) };
    mutate(result, phase);
    return result;
  } };
}

test("SAT scripts fix command and input boundaries without overriding initial state", () => {
  const scripts = createSatScripts({ ...config, sources: ["src/top.v", "properties/check.v"], includeDirs: [".", "src", "src"] });
  assert.match(scripts.prepare, /read_verilog -formal -I\. -Isrc "src\/top.v"/);
  assert.match(scripts.prepare, /opt_clean; check -assert; write_json/);
  assert.match(scripts.prepare, /read_verilog -formal -I\. -Isrc "properties\/check.v"/);
  assert.match(scripts.presat, /sat -seq 4 -set-assumes/);
  assert.match(scripts.proof, /-prove-asserts -verify/);
  assert.doesNotMatch(Object.values(scripts).join("\n"), /-set-init-zero|-ignore-unknown-cells|-sv|exec|plugin/);
  assert.match(createSatScripts({ ...config, mode: "prove" }).proof, /-tempinduct -maxsteps 4/);
  assert.doesNotMatch(scripts.prepare, /-icells/);
  assert.match(createSatScripts({ ...config, internalCells: true }).prepare, /read_verilog -formal -icells/);
  for (const change of [
    { sources: [] }, { sources: ["src/top.v", "src/top.v"] }, { sources: ["src/top.sv"] },
    { sources: ["../top.v"] }, { sources: ["/top.v"] }, { sources: ["a; shell.v"] },
    { sources: ["__formal/injected.v"] }, { includeDirs: ["../escape"] },
    { includeDirs: ["src\nexec"] }, { includeDirs: [null] }, { top: "top; shell" },
    { top: "-top" }, { mode: "cover" }, { depth: 0 }, { depth: 1001 }, { depth: "4" },
    { timeout: 0 }, { timeout: 301 }, { internalCells: 1 }, { internalCells: "true" },
  ]) assert.throws(() => createSatScripts({ ...config, ...change }));
});

test("bounded success never becomes an unbounded proof", async () => {
  const executor = execution();
  const result = await runSatFormal({ ...config, ...executor });
  assert.equal(result.status, "bounded-safe");
  assert.equal(result.depth, 4);
  assert.deepEqual(executor.phases, ["prepare", "presat", "proof"]);
  assert.equal((await runSatFormal({ ...config, mode: "prove", ...execution() })).status, "error");
  const proven = await runSatFormal({ ...config, mode: "prove", ...execution({
    proof: "Base case for induction length 1 proven.\nInduction step proven: SUCCESS!\n",
  }) });
  assert.equal(proven.status, "proved");
});

test("inconsistent assumptions and zero properties stop before proof", async () => {
  const inconsistent = execution({ presat: "SAT solving finished - no model found.\n" });
  assert.equal((await runSatFormal({ ...config, ...inconsistent })).status, "inconsistent-assumptions");
  assert.deepEqual(inconsistent.phases, ["prepare", "presat"]);
  const empty = execution({ mutate(result) {
    for (const name of ["before", "after"]) result.files.set(`__formal/${name}.json`, '{"modules":{"top":{"cells":{},"ports":{}}}}');
  } });
  assert.equal((await runSatFormal({ ...config, ...empty })).status, "error");
  assert.deepEqual(empty.phases, ["prepare"]);
});

test("counterexamples need failure exit status, witness and VCD, and remain unverified until replay", async () => {
  const proof = "SAT proof finished - model found: FAIL!\n";
  const result = await runSatFormal({ ...config, ...execution({ proof, exitCode: 1 }) });
  assert.equal(result.status, "counterexample");
  assert.equal(result.replay, "pending");
  for (const mutate of [
    (value) => { value.exitCode = 0; },
    (value) => { value.files.delete("__formal/witness.vcd"); },
    (value) => { value.files.delete("__formal/witness.json"); },
    (value) => { value.files.set("__formal/witness.json", '{"signal":[]}'); },
    (value) => { value.files.set("__formal/witness.json", "malformed"); },
    (value) => { value.files.set("__formal/witness.vcd", "no VCD"); },
  ]) {
    const executor = execution({ proof, exitCode: 1, mutate: (value, phase) => { if (phase === "proof") mutate(value); } });
    assert.equal((await runSatFormal({ ...config, ...executor })).status, "error");
  }
});

test("unknown, crash, timeout, base-only, malformed and ambiguous statuses fail closed", async () => {
  for (const proof of [
    "unknown\n", "timeout\n", "", "SUCCESS!\n", "Induction step proven: SUCCESS!\n",
    "Reached maximum number of time steps -> proved base case for 4 steps: SUCCESS!\n",
    "SAT proof finished - no model found: SUCCESS!\nSAT proof finished - no model found: SUCCESS!\n",
    "SAT proof finished - no model found: SUCCESS!\nSAT proof finished - model found: FAIL!\n",
  ]) assert.equal((await runSatFormal({ ...config, ...execution({ proof }) })).status, "error");
  for (const presat of ["", "unknown\n", "SAT solving finished - model found:\nSAT solving finished - no model found.\n"]) {
    assert.equal((await runSatFormal({ ...config, ...execution({ presat }) })).status, "error");
  }
  for (const mutate of [
    (value) => { value.exitCode = null; }, (value) => { value.exitCode = 1; },
    (value) => { value.stdout = null; }, (value) => { value.stderr = undefined; },
    (value) => { value.files = null; },
  ]) assert.equal((await runSatFormal({ ...config, ...execution({ mutate }) })).status, "error");
  assert.equal((await runSatFormal({ ...config, execute: async () => { throw new Error("worker crashed"); } })).status, "error");
});
