#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { verifyGhdlReplay } from "../tests/synth/ghdl-replay-helpers.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
export const columns = ["case", "frontend", "runtime", "phase", "expected", "actual", "exitStatus", "signal", "error", "elapsedMs", "steps", "failures",
  "sourceSha256", "witnessSha256", "protocolSha256", "stdoutSha256", "stderrSha256", "vcdSha256", "pslReportSha256"];

export function parseReplayCsv(csv) {
  const lines = csv.split("\n");
  assert.equal(lines.shift(), columns.join(","), "Unexpected replay CSV header");
  assert.equal(lines.pop(), "", "Incomplete replay CSV");
  return lines.map((line) => {
    const cells = [], pattern = /"((?:[^"\r\n]|"")*)"(,|$)/gy;
    let offset = 0, match, ended = false;
    while ((match = pattern.exec(line))) {
      assert.equal(match.index, offset);
      cells.push(match[1].replaceAll('""', '"'));
      offset = pattern.lastIndex;
      if (match[2] === "") { ended = true; break; }
    }
    assert.ok(ended && offset === line.length && cells.length === columns.length, "Malformed replay CSV row");
    return Object.fromEntries(columns.map((name, index) => [name, cells[index]]));
  });
}

export function auditGhdlReplay(directory, { preliminary = false } = {}) {
  const manifest = load(path.join(directory, "manifest.json"));
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.workingTree, "string");
  if (!preliminary) assert.equal(manifest.workingTree, "", "Official replay requires a clean revision");
  const provenance = load(path.join(directory, "native-replay-manifest.json"));
  assert.ok(provenance.compiler.length > 0 && provenance.vpiConfig.cflags && provenance.vpiConfig.ldflags);
  const native = path.resolve(provenance.vpiConfig["include-dir"], "../../bin/ghdl");
  const plugin = Object.keys(provenance.hashes).filter((name) => name.endsWith("/native-replay-plugin/replay.vpi"));
  assert.equal(plugin.length, 1);
  const inputs = [native, plugin[0], path.join(provenance.vpiConfig["include-dir"], "vpi_user.h"),
    path.join(provenance.vpiConfig["library-dir"], "libghdlvpi.so"),
    ...["vpi.c", "helpers.mjs", "vcd.mjs"].map((name) => `tests/synth/ghdl-replay-${name}`)];
  assert.deepEqual(Object.keys(provenance.hashes).toSorted(), inputs.map((name) => path.relative(root, path.resolve(root, name))).toSorted());
  for (const [name, expected] of Object.entries(provenance.hashes)) assert.equal(hash(readFileSync(path.resolve(root, name))), expected, name);
  assert.equal(manifest.nativeSha256, hash(readFileSync(native)));
  assert.equal(manifest.wasmSha256, hash(readFileSync(path.resolve(native, "../../../ghdl-wasm/ghdl-synth.wasm"))));
  const pluginHash = hash(readFileSync(path.join(directory, "native-replay-plugin/replay.vpi")));
  assert.equal(pluginHash, provenance.hashes[plugin[0]]);
  for (const [name, value] of Object.entries(manifest.buildManifest)) {
    if (name.startsWith("source_sha256:")) assert.equal(hash(readFileSync(path.join(root, name.slice("source_sha256:".length)))), value);
  }
  const rows = parseReplayCsv(readFileSync(path.join(directory, "native-replay.csv"), "utf8"));
  const seen = new Set(), times = [];
  for (const row of rows) {
    for (const key of ["case", "phase"]) assert.match(row[key], /^[a-z][a-z0-9-]*$/);
    for (const key of ["frontend", "runtime"]) assert.ok(["native", "wasm"].includes(row[key]));
    const id = [row.case, row.frontend, row.runtime, row.phase].join("/");
    assert.ok(!seen.has(id), `Duplicate replay: ${id}`);
    seen.add(id);
    const parent = path.join(directory, `${row.case}-${row.frontend}`);
    const child = path.join(parent, `${row.runtime}-original-vhdl${row.phase === "positive" ? "" : `-${row.phase}`}`);
    const plan = load(path.join(child, "plan.json")), run = load(path.join(child, "run.json"));
    const analysis = load(path.join(child, "analyze.json")), sat = load(path.join(parent, `${row.runtime}-result.json`));
    assert.equal(analysis.status, 0);
    assert.equal(analysis.signal, null);
    assert.equal(analysis.error, null);
    const flags = ["--std=08", ...(plan.psl ? ["-fpsl"] : [])];
    assert.equal(analysis.command, native);
    assert.deepEqual(analysis.args, ["-a", ...flags, "top.vhd"]);
    assert.equal(run.command, native);
    assert.deepEqual(run.args, ["--elab-run", ...flags, plan.top, "--vpi=./replay.vpi", "--assert-level=none",
      "--backtrace-severity=note", "--psl-report=psl-report.json", "--vcd=formal-ghdl.vcd"]);
    assert.equal(run.signal, null);
    assert.equal(run.error, null);
    assert.equal(run.status, ["positive", "mutated-property", "violated-assumption"].includes(row.phase) ? 0 : 1);
    assert.equal(readFileSync(path.join(child, "analyze.stdout"), "utf8") + readFileSync(path.join(child, "analyze.stderr"), "utf8"), "");
    assert.ok(Number.isFinite(run.elapsedMs) && run.elapsedMs > 0 && Number.isFinite(analysis.elapsedMs) && analysis.elapsedMs > 0);
    for (const [column, field] of [["exitStatus", "status"], ["signal", "signal"], ["error", "error"]]) assert.equal(row[column], String(run[field]), `${id}: ${column}`);
    assert.ok(Number.isFinite(Number(row.elapsedMs)) && Number(row.elapsedMs) >= run.elapsedMs && Number(row.elapsedMs) >= analysis.elapsedMs);
    assert.equal(row.steps, String(plan.steps));
    assert.equal(sat.status, "counterexample");
    assert.deepEqual(plan.properties, sat.inventory.properties);
    assert.deepEqual(load(path.join(child, "witness.json")), sat.witness);
    assert.equal(row.witnessSha256, hash(JSON.stringify(sat.witness)));
    assert.equal(row.protocolSha256, hash(plan.content));
    assert.equal(readFileSync(path.join(child, "formal-ghdl-input.txt"), "utf8"), plan.content);
    assert.equal(hash(readFileSync(path.join(child, "replay.vpi"))), pluginHash);
    const read = (file) => { try { return readFileSync(path.join(child, file)); } catch (error) { assert.equal(error.code, "ENOENT"); return Buffer.alloc(0); } };
    const execution = { ...run, stdout: readFileSync(path.join(child, "run.stdout"), "utf8"), stderr: readFileSync(path.join(child, "run.stderr"), "utf8"),
      vcd: read("formal-ghdl.vcd"), pslReport: read("psl-report.json") };
    for (const [column, file] of [["source", "top.vhd"], ["stdout", "run.stdout"], ["stderr", "run.stderr"], ["vcd", "formal-ghdl.vcd"], ["pslReport", "psl-report.json"]]) {
      assert.equal(row[`${column}Sha256`], hash(["source", "stdout", "stderr"].includes(column) || run.status === 0 ? readFileSync(path.join(child, file)) : read(file)), `${id}: ${column}`);
    }
    const verified = verifyGhdlReplay(plan, execution);
    assert.deepEqual(verified, load(path.join(child, "verification.json")));
    assert.equal(row.failures, JSON.stringify(verified.failures ?? verified.reason));
    assert.equal(row.expected, row.phase === "positive" ? "verified" : "rejected");
    assert.equal(row.actual, row.expected);
    assert.equal(verified.status, row.actual, id);
    times.push(Number(row.elapsedMs));
  }
  const expected = ["plain-depth4", "plain-depth5", "plain-negedge", "plain-prove", "psl-depth4", "psl-depth5", "psl-activation"]
    .flatMap((name) => ["native", "wasm"].flatMap((frontend) => ["native", "wasm"].map((runtime) => `${name}/${frontend}/${runtime}/positive`)));
  for (const phase of ["wrong-output", "missing-port", "wrong-port-direction", "incomplete-port-inventory", "malformed-step", "duplicate-port",
    "unknown-input-data", "extra-input-data", "mutated-property", "mutated-initial-value", "unknown-output", "violated-assumption"]) {
    expected.push(`${phase === "violated-assumption" ? "psl" : "plain"}-depth4/native/native/${phase}`);
  }
  assert.deepEqual([...seen].toSorted(), expected.toSorted(), "Incomplete replay matrix");
  times.sort((a, b) => a - b);
  return { revision: manifest.revision, preliminary, rows: rows.length, columns: columns.length, positives: 28, negativeControls: 12,
    elapsedMs: { min: times[0], median: (times[19] + times[20]) / 2, max: times.at(-1) },
    csvSha256: hash(readFileSync(path.join(directory, "native-replay.csv"))), rowsAudited: rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { sample: { type: "string", multiple: true }, out: { type: "string" }, preliminary: { type: "boolean", default: false } } });
  assert.ok(values.sample?.length && values.out, "Required: --sample DIRECTORY --out NEW_DIRECTORY");
  const samples = values.sample.map((directory) => auditGhdlReplay(path.resolve(directory), values));
  assert.equal(new Set(samples.map(({ revision }) => revision)).size, 1, "Repetitions use different revisions");
  mkdirSync(values.out);
  writeFileSync(path.join(values.out, "audit.json"), JSON.stringify({ samples }, null, 2), { flag: "wx" });
  console.log(`Audited ${samples.length} replay samples, ${samples.reduce((sum, sample) => sum + sample.rows, 0)} rows, ${columns.length} columns${values.preliminary ? " (preliminary)" : ""}`);
}
