import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { assertFormalDistributionMatches } from "../e2e/distribution-preflight.mjs";

test("formal preflight compares Python assets and notices with independently regenerated pinned sources", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const distRoot = mkdtempSync(resolve(tmpdir(), "formal-preflight-"));
  const check = () => assertFormalDistributionMatches({
    repoRoot, distRoot, buildRoot: distRoot,
  });
  try {
    execFileSync("python3", [
      resolve(repoRoot, "scripts/formal-distribution.py"), "stage-licenses", distRoot,
    ]);
    mkdirSync(resolve(distRoot, "formal"));
    execFileSync("python3", [
      resolve(repoRoot, "scripts/build-formal-python.py"),
      "--out", resolve(distRoot, "formal/python"),
    ]);
    const result = check();
    const manifest = JSON.parse(readFileSync(resolve(distRoot, "formal/python/manifest.json")));
    assert.deepEqual(result.python, new Set([
      "formal/python/manifest.json",
      ...manifest.assets.map(asset => `formal/python/${asset.path}`),
    ]));
    assert.ok(result.licenses.has("licenses/yosys-COPYING"));
    for (const path of ["formal/python/manifest.json", "formal/python/sby.py", "licenses/yosys-COPYING"]) {
      const target = resolve(distRoot, path);
      const original = readFileSync(target);
      try {
        writeFileSync(target, Buffer.concat([original, Buffer.from("\n")]));
        assert.throws(check, /public_html\/.* differs from/);
        rmSync(target);
        assert.throws(check, /public_html\/.* is missing/);
      } finally {
        writeFileSync(target, original);
      }
    }
  } finally {
    rmSync(distRoot, { recursive: true, force: true });
  }
});
