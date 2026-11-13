import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { checkE2e, checkPack, playwrightTests } from "../scripts/check-ci-shards.mjs";
import { exactPartition, expectedMatrix, matrixAssignment, packFiles, packShards, parsePackShard, plan, root } from "../scripts/ci-shard-plan.mjs";

function packReports() {
  const catalog = [...expectedMatrix(), ...packFiles.slice(1).map((file) => ({ name: `unit ${file}`, file, shard: "hdl-1" }))];
  return packShards.map((shard) => ({ shard, catalog: structuredClone(catalog), passed: catalog.filter((entry) => entry.shard === shard).map((entry) => entry.name), failures: [], complete: true }));
}

function e2eReports() {
  const full = plan.e2e.flat().map((file) => ({ id: file, file, expected: file === "s5-synthesis.spec.mjs" ? "skipped" : "passed" }));
  return plan.e2e.map((files, index) => ({ shard: index + 1, full: structuredClone(full), complete: true,
    actual: full.filter((test) => files.includes(test.file)).map((test) => ({ ...test, results: [{ status: test.expected }] })),
  }));
}

test("balanced partitions cover every CPU, HDL board and spec exactly once", () => {
  assert.equal(checkPack(packReports()), 63);
  assert.equal(checkE2e(e2eReports()), plan.e2e.flat().length);
  for (const group of plan.cpu) for (const id of group) {
    const assignments = plan.hdl.flat().map((board) => matrixAssignment(true, id, board));
    assert.equal(new Set(assignments).size, 1, "CPU cross-board checks must stay in one process");
  }
});

test("invalid, empty, overlapping and incomplete shard plans fail closed", () => {
  for (const value of ["cpu-0", "cpu-5", "hdl-3", "", "cpu-1/4"]) assert.throws(() => parsePackShard(value));
  for (const groups of [[], [[]], [["a"], ["a"]], [["a"]]]) assert.throws(() => exactPartition(groups, ["a", "b"]));
});

test("parity coverage rejects missing, duplicate, failed, skipped and altered reports", () => {
  for (const mutate of [
    (reports) => reports.pop(),
    (reports) => { reports[0].passed.pop(); },
    (reports) => { reports[0].passed.push(reports[0].passed[0]); },
    (reports) => { reports[1].passed.push(reports[0].passed[0]); },
    (reports) => { reports[0].failures.push("failed"); },
    (reports) => { reports[0].complete = false; },
    (reports) => { reports[0].catalog.pop(); },
    (reports) => { for (const report of reports) report.catalog = report.catalog.filter((entry) => entry.name !== "hazard3/tangnano1k"); },
    (reports) => { reports[0].shard = reports[1].shard; },
  ]) { const reports = packReports(); mutate(reports); assert.throws(() => checkPack(reports)); }
  assert.throws(() => checkPack([]));
});

test("Playwright coverage rejects missing, duplicate, retried, skipped and cancelled tests", () => {
  for (const mutate of [
    (reports) => reports.pop(),
    (reports) => { reports[0].actual.pop(); },
    (reports) => { reports[0].actual.push(reports[0].actual[0]); },
    (reports) => { reports[0].actual[0].results.push({ status: "passed" }); },
    (reports) => { reports[0].actual[0].results[0].status = "skipped"; },
    (reports) => { reports[0].actual[0].results[0].status = "interrupted"; },
    (reports) => { reports[0].complete = false; },
    (reports) => { reports[1].full.pop(); },
    (reports) => { reports[1].shard = 1; },
    (reports) => { reports[0].actual[0].expected = "skipped"; },
  ]) { const reports = e2eReports(); mutate(reports); assert.throws(() => checkE2e(reports)); }
  assert.throws(() => checkE2e([]));
});

test("Playwright JSON inventory validates errors, duplicates and empty collections", () => {
  const report = { errors: [], suites: [{ specs: [{ id: "a", file: "a.spec.mjs", tests: [{ projectName: "chromium", expectedStatus: "passed", results: [] }] }] }] };
  assert.equal(playwrightTests(report)[0].id, "a/chromium");
  report.suites.push(report.suites[0]);
  assert.throws(() => playwrightTests(report));
  assert.throws(() => playwrightTests({ suites: [] }));
  assert.throws(() => playwrightTests({ ...report, errors: ["collection failed"] }));
});

test("real Node event collection records successes, exclusions and failures without stale output reuse", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ci-shard-tests-"));
  const file = path.join(directory, "fixture.test.mjs");
  const runner = pathToFileURL(path.join(root, "scripts/run-ci-shard.mjs")).href;
  const wrapper = pathToFileURL(path.join(root, "tests/synth/pack-sharding.mjs")).href;
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const invoke = (shard, output) => {
    const entry = path.join(directory, "entry.mjs");
    writeFileSync(entry, `import { runPack } from ${JSON.stringify(runner)}; await runPack(${JSON.stringify(shard)}, ${JSON.stringify(output)}, [${JSON.stringify(file)}]);`);
    return spawnSync(process.execPath, [entry], { encoding: "utf8", env });
  };
  try {
    writeFileSync(file, `import { createPackTest } from ${JSON.stringify(wrapper)}; const test = createPackTest(import.meta.url); test('fixture pass', () => {});`);
    let result = invoke("hdl-1", path.join(directory, "pass"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(path.join(directory, "pass/result.json")));
    assert.deepEqual(report.passed, ["fixture pass"]);
    assert.equal(report.complete, true);
    assert.notEqual(invoke("hdl-1", path.join(directory, "pass")).status, 0);
    result = invoke("cpu-1", path.join(directory, "skip"));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "skip/result.json"))).passed, []);
    writeFileSync(file, `import { createPackTest } from ${JSON.stringify(wrapper)}; createPackTest(import.meta.url)('pinned CPU libraries retain execution and classify all four board builds', async (t) => { await t.test('hazard3/tangnano1k', () => {}); });`);
    result = invoke("cpu-1", path.join(directory, "nested"));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(directory, "nested/result.json"))).passed, ["hazard3/tangnano1k"]);
    writeFileSync(file, `import { createPackTest } from ${JSON.stringify(wrapper)}; createPackTest(import.meta.url)('fixture failure', () => { throw Error('negative control'); });`);
    assert.notEqual(invoke("hdl-1", path.join(directory, "fail")).status, 0);
    assert.ok(JSON.parse(readFileSync(path.join(directory, "fail/result.json"))).failures.length);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("coverage CLI accepts complete artifacts and rejects absent, malformed and unexpected reports", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ci-coverage-cli-"));
  const invoke = () => spawnSync(process.execPath, ["scripts/check-ci-shards.mjs", "pack", directory], { cwd: root, encoding: "utf8" });
  try {
    assert.notEqual(invoke().status, 0);
    for (const report of packReports()) {
      const dir = path.join(directory, `parity-shard-${report.shard}`);
      mkdirSync(dir);
      writeFileSync(path.join(dir, "result.json"), JSON.stringify(report));
    }
    assert.equal(invoke().status, 0);
    writeFileSync(path.join(directory, "extra.json"), "{}");
    assert.notEqual(invoke().status, 0);
    rmSync(path.join(directory, "extra.json"));
    writeFileSync(path.join(directory, "parity-shard-cpu-1/result.json"), "{");
    assert.notEqual(invoke().status, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("required-name aggregators reject failed, cancelled, skipped and missing dependencies", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/build.yml"), "utf8");
  for (const job of ["pyodide-pack", "e2e"]) {
    const body = workflow.split(`  ${job}:\n`)[1].split(/^  [a-z][a-z-]*:\n/m)[0];
    assert.match(body, /if: always\(\)/);
    assert.match(body, /parity-coverage|e2e-coverage/);
    const expected = /EXPECTED_NEEDS: (.+)/.exec(body)[1].split(",");
    const script = /          import json, os\n([\s\S]+?)          PYTHON/.exec(body)[0].replace(/          PYTHON$/, "").replace(/^          /gm, "");
    for (const status of ["success", "failure", "cancelled", "skipped", "missing"]) {
      const needs = Object.fromEntries(expected.map((name) => [name, { result: "success" }]));
      if (status === "missing") delete needs[expected[1]]; else needs[expected[1]].result = status;
      const result = spawnSync("python3", ["-c", script], { env: { ...process.env, NEEDS_RESULTS: JSON.stringify(needs), EXPECTED_NEEDS: expected.join(",") } });
      assert.equal(result.status === 0, status === "success");
    }
  }
  assert.match(workflow, /name: Pyodide gowin_pack \(\$\{\{ matrix.suite \}\}\)/);
  assert.match(workflow, /name: Playwright E2E\n/);
  assert.equal((workflow.match(/if: matrix.suite == 'hdl' && matrix.shard == 1\n/g) ?? []).length, 3);
});
