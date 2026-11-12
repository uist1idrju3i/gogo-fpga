import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "./sharding.mjs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");
const detectRunner = resolve(import.meta.dirname, "run-detect.mjs");
const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
const availableVariants = [
  "jspi-pthread",
  "asyncify-pthread",
];
const variants = process.env.WASM_VARIANTS
  ? process.env.WASM_VARIANTS.split(",").map((variant) => variant.trim())
  : availableVariants.filter((variant) =>
      ["openFPGALoader.mjs", "openFPGALoader.wasm"].every((artifact) =>
        existsSync(resolve(buildRoot, variant, artifact)),
      ),
    );
assert.ok(variants.length > 0, `No built WASM variants found under ${buildRoot}`);
for (const variant of variants) {
  for (const artifact of ["openFPGALoader.mjs", "openFPGALoader.wasm"]) {
    assert.ok(
      existsSync(resolve(buildRoot, variant, artifact)),
      `Missing ${artifact} for ${variant} under ${buildRoot}`,
    );
  }
}
const boards = [
  { name: "Tang Nano 1K", board: "tangnano1k", idcode: 0x0100681b, part: /GW1NZ-1/ },
  { name: "Tang Nano 4K", board: "tangnano4k", idcode: 0x0100981b, part: /GW1NSR-4C/ },
  {
    name: "Tang Nano 9K",
    board: "tangnano9k",
    idcode: 0x1100481b,
    detectedIdcode: 0x0100481b,
    part: /GW1N\(R\)-9C/,
  },
  {
    name: "Tang Nano 20K",
    board: "tangnano20k",
    idcode: 0x0000081b,
    part: /GW2A\(R\)-18\(C\)/,
  },
];

function runDetect(variant, idcode, args = ["--detect"], connected = true) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [detectRunner, variant, idcode.toString(16), JSON.stringify(args), String(connected)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (child.error) {
    throw new Error(`Detect subprocess failed: ${child.error.message}`, { cause: child.error });
  }
  const marker = /(?:^|\r?\n)__DETECT_RESULT__(\{[^\r\n]*\})(?:\r?\n|$)/.exec(child.stderr);
  assert.ok(
    marker,
    `Detect subprocess returned ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
  );
  const result = JSON.parse(marker[1]);
  return {
    exitCode: result.exitCode,
    isPromise: result.isPromise,
    output: `${child.stdout}\n${child.stderr.replace(marker[0], "\n")}`,
    elapsedMs: result.elapsedMs,
  };
}

for (const variant of variants) {
  for (const board of boards) {
    test(`${variant}: ${board.name} --detect`, async () => {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        const result = runDetect(variant, board.idcode);
        assert.equal(result.exitCode, 0, result.output);
        if (!variant.startsWith("asyncify-")) {
          assert.equal(result.isPromise, true, "JSPI callMain must return a Promise");
        }
        const idcode = (board.detectedIdcode ?? board.idcode).toString(16).replace(/^0+/, "");
        assert.match(result.output, new RegExp(`0x0*${idcode}`, "i"));
        assert.match(result.output, board.part);
        console.log(
          `MEASURE,${variant},${board.name},${repeat},${result.elapsedMs.toFixed(3)},${board.idcode.toString(16)}`,
        );
      }
    });

    test(`${variant}: -b ${board.board} --detect`, async () => {
      for (let repeat = 1; repeat <= 5; repeat += 1) {
        const result = runDetect(variant, board.idcode, ["-b", board.board, "--detect"]);
        assert.equal(result.exitCode, 0, result.output);
        if (!variant.startsWith("asyncify-")) {
          assert.equal(result.isPromise, true, "JSPI callMain must return a Promise");
        }
        const idcode = (board.detectedIdcode ?? board.idcode).toString(16).replace(/^0+/, "");
        assert.match(result.output, new RegExp(`0x0*${idcode}`, "i"));
        assert.match(result.output, board.part);
        console.log(
          `MEASURE,${variant},${board.board} --detect,${repeat},${result.elapsedMs.toFixed(3)},${board.idcode.toString(16)}`,
        );
      }
    });
  }

  test(`${variant}: --detect reports no device`, async () => {
    const result = runDetect(variant, 0x0100681b, ["--detect"], false);
    assert.notEqual(result.exitCode, 0, result.output);
    assert.match(result.output, /unable to open|no device|not found|failed to open/i);
    console.log(`MEASURE,${variant},no-device,${result.elapsedMs.toFixed(3)},`);
  });
}
