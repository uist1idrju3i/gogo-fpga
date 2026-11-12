import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compareSolverResults } from "../synth/solver-protocol-cases.mjs";
import { loadSolverProbe, root, digest } from "../synth/solver-protocol-helpers.mjs";

const good = () => ({ verdict: "pass", failure: null, status: "exited", exitCode: 0,
  stdout: Buffer.from("sat\n"), stderr: Buffer.alloc(0), frames: ["sat"] });

test("solver comparison requires both successful contracts and exact independent outputs", () => {
  compareSolverResults(good(), good());
  for (const change of [
    { verdict: "error", failure: "Invalid response" }, { status: "timeout" }, { exitCode: 1 },
    { stdout: Buffer.from("unsat\n") }, { stderr: Buffer.from("error\n") }, { frames: ["unknown"] },
    { signal: "SIGKILL" }, { framingError: "Incomplete response" },
  ]) {
    assert.throws(() => compareSolverResults(good(), { ...good(), ...change }));
    assert.throws(() => compareSolverResults({ ...good(), ...change }, good()));
  }
});

test("probe loader rejects missing evidence, different source, script, patch, and artifact", () => {
  mkdirSync(path.join(root, "build/S15"), { recursive: true });
  const directory = mkdtempSync(path.join(root, "build/S15/protocol-loader-"));
  try {
    const source = execFileSync("git", ["ls-tree", "HEAD", "vendor/yices2"], { cwd: root, encoding: "utf8" }).match(/^160000 commit ([a-f0-9]{40})\t/)[1];
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const buildScript = execFileSync("git", ["show", `${commit}:scripts/build-solver-probe.py`], { cwd: root });
    const script = digest(buildScript);
    const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
    writeFileSync(path.join(directory, "solver.wasm"), bytes, { flag: "wx" });
    const goodInfo = () => ({ status: "built", solver: "yices2", runtime: "wasi", worktree_status: "",
      base_commit: commit, source: { commit: source }, script_sha256: script, patches: [],
      artifact: { path: "solver.wasm", bytes: bytes.length, sha256: digest(bytes) } });
    const load = info => {
      writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(info));
      return loadSolverProbe(directory, "yices2", "wasi");
    };
    assert.throws(() => loadSolverProbe(directory, "yices2", "wasi"), /ENOENT/);
    assert.deepEqual(load(goodInfo()).binary, new Uint8Array(bytes));
    assert.deepEqual(load(goodInfo()).buildScript, buildScript);
    for (const change of [
      { status: "error" }, { solver: "z3" }, { runtime: "native" }, { worktree_status: " M scripts/build-solver-probe.py" },
      { source: { commit: "0".repeat(40) } }, { script_sha256: "0".repeat(64) },
      { base_commit: "--output=unexpected" }, { base_commit: null },
      { patches: [{ path: "scripts/build-solver-probe.py", sha256: "0".repeat(64) }] },
      { artifact: { path: "../solver.wasm", bytes: bytes.length, sha256: digest(bytes) } },
      { artifact: { path: "solver.wasm", bytes: bytes.length + 1, sha256: digest(bytes) } },
      { artifact: { path: "solver.wasm", bytes: bytes.length, sha256: "0".repeat(64) } },
    ]) assert.throws(() => load({ ...goodInfo(), ...change }));
    writeFileSync(path.join(directory, "solver.wasm"), Buffer.alloc(bytes.length));
    assert.throws(() => load(goodInfo()));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
