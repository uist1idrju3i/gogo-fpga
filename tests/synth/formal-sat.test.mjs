import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runSatFormal } from "../../web/lib/formal-sat.mjs";
import { createFormalExecutors } from "./formal-helpers.mjs";
import { satFormalCases } from "./formal-sat-cases.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const nativePath = path.join(root, "build/native/yosys");
const wasmPath = path.join(root, "build/wasi/yosys/yosys.wasm");
mkdirSync(path.join(root, "build/S15"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/S15/p1-sat-"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
writeFileSync(path.join(evidence, "manifest.json"), JSON.stringify({
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  workingTree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  node: process.version,
  nativeVersion: execFileSync(nativePath, ["-V"], { encoding: "utf8" }).trim(),
  nativeSha256: hash(readFileSync(nativePath)), wasmSha256: hash(readFileSync(wasmPath)),
}, null, 2));
console.log(`Retained formal SAT evidence: ${evidence}`);

for (const { kind: _kind, ...scenario } of satFormalCases) {
  test(`formal native/WASI ${scenario.name}`, async () => {
    const execute = createFormalExecutors(evidence, scenario.name, scenario.source);
    const results = [];
    for (const runtime of ["native", "wasm"]) {
      const result = await runSatFormal({ sources: ["top.v"], top: "top", depth: 8, ...scenario, execute: execute[runtime] });
      writeFileSync(path.join(evidence, scenario.name, `${runtime}-result.json`), JSON.stringify({
        ...result, observations: result.observations.map(({ files, ...observation }) => ({
          ...observation, files: [...files.keys()],
        })),
      }, null, 2));
      assert.equal(result.status, scenario.expected, `${runtime}: ${result.message ?? ""}`);
      if (result.status === "counterexample") assert.equal(result.replay, "pending");
      results.push(result);
    }
    assert.deepEqual(results[0].inventory, results[1].inventory);
    assert.equal(results[0].status, results[1].status);
  });
}
