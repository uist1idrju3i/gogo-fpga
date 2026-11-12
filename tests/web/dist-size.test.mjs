import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const checkScript = resolve(
  import.meta.dirname,
  "../../scripts/check-dist-size.py",
);
const limit = 25 * 1024 * 1024;

test("distribution size check rejects files at the 25 MiB limit", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "toolchain-dist-size-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "large.wasm");
  writeFileSync(file, "");
  truncateSync(file, limit - 1);
  const belowLimit = spawnSync("python3", [checkScript, directory], {
    encoding: "utf8",
  });
  assert.equal(belowLimit.status, 0, belowLimit.stderr);

  truncateSync(file, limit);
  const atLimit = spawnSync("python3", [checkScript, directory], {
    encoding: "utf8",
  });
  assert.notEqual(atLimit.status, 0);
  assert.match(atLimit.stderr, /large\.wasm \(26214400 bytes; limit 26214400\)/);
});
