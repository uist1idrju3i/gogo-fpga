import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateFormalToolCommand } from "../../web/lib/formal-tool-command.mjs";
import { sbyConfig, sbyCases, selectFormalSolvers } from "../synth/formal-sby-cases.mjs";
import { digest, verifyNativeSolver } from "../synth/solver-protocol-helpers.mjs";

const smtbmc = ["yosys-smtbmc", "-s", "yices", "--presat", "--unroll", "--noprogress", "-t", "6", "--append", "0",
  "--dump-vcd", "engine_0/trace%.vcd", "--dump-yw", "engine_0/trace%.yw", "--dump-vlogtb", "engine_0/trace%_tb.v",
  "--dump-smtc", "engine_0/trace%.smtc", "model/design_smt2.smt2"];

test("formal commands preserve upstream BMC, induction, cover and witness argv without invoking a shell", () => {
  for (const extra of [[], ["-i"], ["-c"]]) {
    const args = [...smtbmc.slice(0, -1), ...extra, smtbmc.at(-1)];
    assert.deepEqual(validateFormalToolCommand(args, "result"), { runtime: "python", entrypoint: "smtbmc", args: args.slice(1) });
  }
  for (const stem of ["design", "design_prep", "design_smt2", "trace0", "trace_induct"]) {
    assert.deepEqual(validateFormalToolCommand(["yosys", "-ql", `${stem}.log`, `${stem}.ys`], "result/model"), { runtime: "wasi" });
  }
  const args = ["yosys-witness", "aiw2yw", "engine_0/trace.aiw", "model/design_aiger.ywa", "engine_0/trace.yw"];
  assert.deepEqual(validateFormalToolCommand(args, "result"), { runtime: "python", entrypoint: "witness", args: args.slice(1) });
});

test("diagnostic solvers require an explicit selection while preserving the qualified defaults", () => {
  assert.deepEqual(selectFormalSolvers(), ["yices2", "z3"]);
  for (const solver of ["yices2", "z3", "boolector", "bitwuzla"]) {
    assert.deepEqual(selectFormalSolvers(solver), [solver]);
    const name = solver === "yices2" ? "yices" : solver;
    assert.ok(sbyConfig(sbyCases[0], solver).includes(`smtbmc ${name}\n`));
    const args = smtbmc.map(value => value === "yices" ? name : value);
    assert.equal(validateFormalToolCommand(args, "result").runtime, "python");
  }
  for (const solver of ["", "unsupported", null, 0]) assert.throws(() => selectFormalSolvers(solver));
  assert.throws(() => sbyConfig(sbyCases[0]));
});

test("native solver lookup rejects PATH fallback, shadow binaries and a changed binary hash", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "native-solver-"));
  t.after(() => rmSync(tmp, { recursive: true }));
  const bins = [path.join(tmp, "expected"), path.join(tmp, "shadow")];
  const raw = "#!/bin/sh\nexit 0\n";
  for (const bin of bins) {
    mkdirSync(bin); writeFileSync(path.join(bin, "unit-solver"), raw); chmodSync(path.join(bin, "unit-solver"), 0o755);
  }
  const env = prefix => ({ ...process.env, PATH: `${prefix}${path.delimiter}${process.env.PATH}` });
  const sha = digest(raw);
  assert.deepEqual(verifyNativeSolver("unit-solver", bins[0], sha, env(bins[0])), { path: path.join(bins[0], "unit-solver"), sha256: sha });
  assert.throws(() => verifyNativeSolver("unit-solver", bins[0], sha, env(bins[1])), /outside/);
  assert.throws(() => verifyNativeSolver("unit-solver", bins[0], "0".repeat(64), env(bins[0])), /hash/);
  assert.throws(() => verifyNativeSolver("unit-solver", bins[0], sha, env("")), /outside/);
});

test("formal commands reject unknown executables, shell operators, unsupported options and unsafe artifact paths", () => {
  const invalid = [
    [], ["sh", "-c", "yosys"], ["yosys", "-p", "read top.v"], ["yosys", "-ql", "/tmp/design.log", "design.ys"],
    ["yosys", "-ql", "design.log", "design.ys", ";", "evil"],
    ["yosys", "-ql", "design.log", "../../design.ys"], ["yosys-witness", "exec", "a", "b", "c"],
    [...smtbmc.slice(0, -1), "--noprogress", smtbmc.at(-1)],
    smtbmc.map(arg => arg === "yices" ? "unsupported" : arg),
    smtbmc.map(arg => arg === "6" ? "-1" : arg),
    smtbmc.map(arg => arg === "engine_0/trace%.vcd" ? "../../outside.vcd" : arg),
    smtbmc.map(arg => arg === "--append" ? "--arbitrary-command" : arg),
    smtbmc.map(arg => arg === "model/design_smt2.smt2" ? "/tmp/model.smt2" : arg),
    smtbmc.filter(arg => arg !== "--noprogress"),
  ];
  for (const args of invalid) assert.throws(() => validateFormalToolCommand(args, "result"), Error, JSON.stringify(args));
  for (const cwd of ["..", "../result", "/result", "result/../other", "result\0suffix", ""]) {
    assert.throws(() => validateFormalToolCommand(smtbmc, cwd));
  }
});
