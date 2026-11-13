import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exactPartition, expectedMatrix, packFiles, packShards, plan } from "./ci-shard-plan.mjs";

function unique(entries, label) {
  assert.equal(new Set(entries).size, entries.length, `Duplicate ${label}`);
}

export function checkPack(reports) {
  assert.equal(reports.length, packShards.length);
  unique(reports.map((report) => report.shard), "shard reports");
  const catalog = reports[0].catalog;
  assert.ok(Array.isArray(catalog) && catalog.length);
  unique(catalog.map((entry) => entry.name), "catalog tests");
  assert.deepEqual([...new Set(catalog.map((entry) => entry.file))].sort(), [...packFiles].sort());
  for (const entry of expectedMatrix()) assert.deepEqual(catalog.find((actual) => actual.name === entry.name), entry, `Missing matrix case ${entry.name}`);
  const union = [];
  for (const report of reports) {
    assert.ok(packShards.includes(report.shard));
    assert.deepEqual(report.catalog, catalog, "Full test collections differ");
    assert.deepEqual(report.failures, []);
    assert.equal(report.complete, true);
    unique(report.passed, "passed tests");
    const expected = catalog.filter((entry) => entry.shard === report.shard).map((entry) => entry.name).sort();
    assert.deepEqual([...report.passed].sort(), expected, `Wrong coverage in ${report.shard}`);
    union.push(...report.passed);
  }
  unique(union, "cross-shard execution");
  assert.deepEqual(union.sort(), catalog.map((entry) => entry.name).sort());
  return union.length;
}

export function playwrightTests(report) {
  const tests = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        assert.ok(spec.id && spec.file && test.expectedStatus);
        tests.push({ id: `${spec.id}/${test.projectName}`, file: path.basename(spec.file), expected: test.expectedStatus, results: test.results });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  }
  assert.deepEqual(report.errors ?? [], []);
  for (const suite of report.suites) visit(suite);
  assert.ok(tests.length, "Empty Playwright collection");
  unique(tests.map((test) => test.id), "Playwright tests");
  return tests;
}

export function checkE2e(reports) {
  assert.equal(reports.length, plan.e2e.length);
  unique(reports.map((report) => report.shard), "E2E shard reports");
  const full = reports[0].full;
  assert.ok(full.length);
  unique(full.map((test) => test.id), "full Playwright tests");
  exactPartition(plan.e2e, [...new Set(full.map((test) => test.file))]);
  const union = [];
  for (const report of reports) {
    assert.ok(Number.isInteger(report.shard) && report.shard >= 1 && report.shard <= plan.e2e.length);
    assert.equal(report.complete, true);
    assert.deepEqual(report.full, full, "Full Playwright collections differ");
    const expected = full.filter((test) => plan.e2e[report.shard - 1].includes(test.file));
    assert.deepEqual(report.actual.map((test) => test.id).sort(), expected.map((test) => test.id).sort());
    unique(report.actual.map((test) => test.id), "executed Playwright tests");
    for (const test of report.actual) {
      const original = expected.find(({ id }) => id === test.id);
      assert.equal(test.file, original.file);
      assert.equal(test.expected, original.expected);
      assert.equal(test.results.length, 1, "A Playwright test did not execute exactly once");
      assert.equal(test.results[0].status, original.expected, `Unexpected result: ${test.id}`);
    }
    union.push(...report.actual.map((test) => test.id));
  }
  unique(union, "cross-shard Playwright execution");
  assert.deepEqual(union.sort(), full.map((test) => test.id).sort());
  return union.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [kind, directory] = process.argv.slice(2);
    assert.ok(kind === "pack" || kind === "e2e");
    const names = kind === "pack" ? packShards.map((shard) => `parity-shard-${shard}`) : plan.e2e.map((_, index) => `e2e-shard-${index + 1}`);
    assert.deepEqual(readdirSync(directory).sort(), [...names].sort(), "Unexpected or missing shard artifacts");
    const reports = names.map((name) => JSON.parse(readFileSync(path.join(directory, name, "result.json"))));
    const count = kind === "pack" ? checkPack(reports) : checkE2e(reports);
    console.log(`All ${count} ${kind} tests covered exactly once across ${names.length} shards.`);
  } catch (error) {
    console.error(`Shard coverage: ${error.message}`);
    process.exitCode = 1;
  }
}
