import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { devNull } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the E2E web rebuild initializes library sources and nested CPU provenance before Playwright", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/build.yml", import.meta.url), "utf8");
  const e2e = workflow.split("\n  e2e:\n")[1];
  assert.ok(e2e, "Missing E2E job");
  const execution = e2e.indexOf("        run: npx playwright test");
  assert.ok(execution >= 0, "Missing Playwright execution");
  const setup = e2e.slice(0, execution).replace(/\\\n\s*/g, " ");
  assert.match(setup, /git submodule update --init --depth 1 -- vendor\/zstd third_party\//);
  assert.match(setup, /git -C third_party\/vexriscv submodule update --init --depth 1 -- pythondata_cpu_vexriscv\/verilog\/ext\/VexRiscv/);
});

test("the pinned library asset builder passes its hermetic regression suite", () => {
  const result = spawnSync("python3", [
    "-m", "unittest", "discover", "-s", "tests/check-library-assets", "-p", "test_*.py", "-v",
  ], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf-8",
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "",
      GIT_AUTHOR_EMAIL: "",
      GIT_COMMITTER_NAME: "",
      GIT_COMMITTER_EMAIL: "",
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
});
