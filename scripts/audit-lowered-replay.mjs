#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";
import { createSatReplay, verifySatReplay } from "../web/lib/formal-replay.mjs";
import { verifyGhdlReplay } from "../tests/synth/ghdl-replay-helpers.mjs";
import { bindLoweredProperties } from "../tests/synth/ghdl-lowered-replay.mjs";

const root = path.resolve(import.meta.dirname, "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const positives = ["plain-depth4", "plain-depth5", "plain-negedge", "initial-nonzero", "synchronous-reset", "multiple-properties", "named-library", "hierarchy", "psl-depth4", "psl-activation"];
const boundaries = { "unknown-initial": ["counterexample", /concrete register initialization/],
  "unconstrained-initial": ["counterexample", /unconstrained initial state/],
  "combinational-loop": ["error", /preparation failed/], "memory": ["error", /Unsupported formal state cell: \$mem/],
  "vacuous-activation": ["bounded-safe", null] };
export const columns = ["case", "frontend", "runtime", "expected", "actual", "exitStatus", "signal", "error", "elapsedMs", "steps", "failures", "sourceSha256", "designSha256", "witnessSha256", "planSha256", "stdoutSha256", "stderrSha256", "vcdSha256", "negativeStatus", "reason"];

export function evidenceFiles(directory, prefix = "") {
  return readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    assert.ok(!entry.isSymbolicLink(), "Unexpected evidence symlink");
    const name = path.join(prefix, entry.name);
    return entry.isDirectory() ? evidenceFiles(directory, name) : [name];
  }).sort();
}

export function serializeLoweredCsv(rows) {
  return columns.join(",") + "\n" + rows.map((row) => columns.map((key) => `"${String(row[key]).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
}

export function validateLoweredCsv(csv, expected) {
  const lines = csv.split("\n");
  assert.equal(lines.shift(), columns.join(","));
  assert.equal(lines.pop(), "", "Incomplete CSV");
  assert.equal(lines.length, expected.length, "Incomplete or duplicated matrix");
  for (const [index, line] of lines.entries()) {
    const cells = [], pattern = /"((?:[^"\r\n]|"")*)"(,|$)/gy;
    let offset = 0, ended = false, match;
    while ((match = pattern.exec(line))) {
      assert.equal(match.index, offset);
      cells.push(match[1].replaceAll('""', '"'));
      offset = pattern.lastIndex;
      if (match[2] === "") { ended = true; break; }
    }
    assert.ok(ended && offset === line.length && cells.length === columns.length, "Malformed CSV row");
    assert.deepEqual(cells, columns.map((key) => String(expected[index][key])), `CSV row ${index}`);
  }
}

function firstFailures(failures) {
  const result = new Map();
  for (const failure of [...failures].sort((a, b) => a.step - b.step)) if (!result.has(failure.id)) result.set(failure.id, failure);
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function inspectLoweredReplay(directory) {
  const read = (file) => readFileSync(path.join(directory, file));
  const load = (file) => JSON.parse(read(file));
  const text = (file) => read(file).toString("utf8");
  const rows = [];
  for (const name of [...positives, ...Object.keys(boundaries)]) {
    assert.deepEqual(load(`${name}/native-execution.json`), { status: 0, signal: null, error: null });
    assert.equal(text(`${name}/native.v`), text(`${name}/wasm.v`));
    for (const frontend of ["native", "wasm"]) for (const runtime of ["native", "wasm"]) {
      const base = `${name}-${frontend}`;
      const sat = load(`${base}/${runtime}-result.json`);
      const expected = boundaries[name]?.[0] ?? "counterexample";
      assert.equal(sat.status, expected);
      const row = Object.fromEntries(columns.map((key) => [key, ""]));
      Object.assign(row, { case: name, frontend, runtime, expected, actual: sat.status,
        sourceSha256: hash(read(`${name}/top.vhd`)), designSha256: hash(read(`${name}/${frontend}.v`)),
        exitStatus: JSON.stringify(sat.observations.map(({ exitCode }) => exitCode)), signal: "null", error: "null", elapsedMs: "not-measured" });
      if (boundaries[name]) {
        Object.assign(row, { stdoutSha256: JSON.stringify(sat.observations.map(({ stdout }) => hash(Buffer.from(stdout)))),
          stderrSha256: JSON.stringify(sat.observations.map(({ stderr }) => hash(Buffer.from(stderr)))),
          error: JSON.stringify(sat.status === "error" ? sat.message : null) });
        for (const observation of sat.observations) assert.ok(Number.isInteger(observation.exitCode) && observation.exitCode >= 0 && observation.exitCode <= 255, "Invalid Yosys process exit");
        if (name === "combinational-loop") {
          assert.equal(sat.observations[0].exitCode, 1);
          assert.match(stripVTControlCharacters(sat.observations[0].stdout), /Warning: Wire top\.\\ring is used but has no driver\./);
        }
        if (name.endsWith("initial")) {
          const doc = load(runtime === "native" ? `${base}/native/__formal/before.json` : `${base}/wasm-before.json`);
          let reason;
          try { createSatReplay({ document: doc, witness: sat.witness, top: "top", clock: "clk", depth: 4 }); } catch (error) { reason = error.message; }
          assert.match(reason, boundaries[name][1]);
          row.reason = reason;
          row.negativeStatus = "rejected";
        } else if (boundaries[name][1]) {
          assert.match(sat.message, boundaries[name][1]);
          row.reason = sat.message;
        } else {
          assert.ok(sat.inventory.properties.some(({ id, kind }) => id === "p_bound_cover" && kind === "cover"));
          row.reason = "Bounded result only; activation cover is retained, not proved reachable";
        }
      } else {
        const original = `${base}/${runtime}-original-vhdl`, replay = `${base}-${runtime}-emitted/replay`;
        const document = load(`${replay}/document.json`), emitted = load(`${replay}/emitted-document.json`), common = load(`${replay}/common-plan.json`);
        const sourceDocument = load(`${replay}/source-document.json`);
        assert.deepEqual(common, createSatReplay({ document: sourceDocument, witness: sat.witness, top: "top", clock: "clk", depth: common.steps, edge: name === "plain-negedge" ? "negedge" : "posedge" }));
        const ghdlPlan = load(`${original}/plan.json`), plan = load(`${replay}/plan.json`);
        assert.deepEqual(ghdlPlan.properties, sat.inventory.properties);
        assert.deepEqual(load(`${original}/witness.json`), sat.witness);
        assert.deepEqual(plan, bindLoweredProperties(common, document, emitted, { top: "top", clock: "clk", edge: name === "plain-negedge" ? "negedge" : "posedge" }));
        const ghdlExecution = { ...load(`${original}/execution.json`), stdout: text(`${original}/run.stdout`), stderr: text(`${original}/run.stderr`),
          vcd: read(`${original}/formal-ghdl.vcd`), pslReport: read(`${original}/psl-report.json`) };
        assert.equal(ghdlExecution.status, 0);
        assert.equal(ghdlExecution.signal, null);
        assert.equal(ghdlExecution.error, null);
        const verified = verifyGhdlReplay(ghdlPlan, ghdlExecution);
        assert.equal(verified.status, "verified", verified.reason);
        assert.deepEqual(verified, load(`${original}/verification.json`));
        const statuses = { ghdl: 0 }, stdout = [hash(Buffer.from(ghdlExecution.stdout))], stderr = [hash(Buffer.from(ghdlExecution.stderr))], vcd = [hash(ghdlExecution.vcd)];
        let elapsedMs = ghdlExecution.elapsedMs;
        for (const engine of ["native", "wasm", "wrong-output"]) {
          const execution = { ...load(`${replay}/${engine}-execution.json`), stdout: text(`${replay}/${engine}.stdout`), stderr: text(`${replay}/${engine}.stderr`), vcd: read(`${replay}/${engine}.vcd`) };
          assert.equal(execution.signal, null);
          assert.equal(execution.error, null);
          statuses[engine] = execution.status;
          const result = verifySatReplay(engine === "wrong-output" ? load(`${replay}/wrong-output-plan.json`) : plan, execution);
          assert.deepEqual(result, load(`${replay}/${engine}-verification.json`));
          assert.equal(result.status, engine === "wrong-output" ? "rejected" : "verified", result.reason);
          assert.equal(execution.status, engine === "wrong-output" ? 1 : 0);
          if (engine !== "wrong-output") {
            assert.ok(Number.isFinite(execution.elapsedMs) && execution.elapsedMs > 0);
            elapsedMs += execution.elapsedMs;
            assert.deepEqual(firstFailures(result.failures), firstFailures(verified.failures));
            for (const failure of result.failures) assert.ok(verified.failures.some((other) =>
              other.id === failure.id && other.source === failure.source && other.step === failure.step));
          }
          stdout.push(hash(Buffer.from(execution.stdout))); stderr.push(hash(Buffer.from(execution.stderr))); vcd.push(hash(execution.vcd));
        }
        for (const values of [stdout, stderr, vcd]) assert.equal(values[1], values[2], "Native/WASM Icarus bytes differ");
        Object.assign(row, { expected: "verified", actual: "verified", exitStatus: JSON.stringify(statuses), elapsedMs,
          steps: plan.steps, failures: JSON.stringify(verified.failures), witnessSha256: hash(JSON.stringify(sat.witness)),
          planSha256: hash(read(`${replay}/plan.json`)), stdoutSha256: JSON.stringify(stdout), stderrSha256: JSON.stringify(stderr),
          vcdSha256: JSON.stringify(vcd), negativeStatus: "rejected", reason: "First violation per property agrees; full event lists retained" });
      }
      rows.push(row);
    }
  }
  assert.equal(rows.length, 60);
  return rows;
}

export function auditLoweredReplay(directory, { preliminary = false } = {}) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json")));
  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.equal(typeof manifest.workingTree, "string");
  if (!preliminary) assert.equal(manifest.workingTree, "", "Formal repetitions require a clean revision");
  assert.deepEqual(Object.keys(manifest.files).sort(), evidenceFiles(directory).filter((name) => name !== "manifest.json"));
  for (const [name, expected] of Object.entries(manifest.files)) assert.equal(hash(readFileSync(path.join(directory, name))), expected, name);
  for (const [name, expected] of Object.entries(manifest.hashes)) assert.equal(hash(readFileSync(path.resolve(root, name))), expected, name);
  for (const [name, expected] of Object.entries(manifest.buildManifest)) if (name.startsWith("source_sha256:")) assert.equal(hash(readFileSync(path.join(root, name.slice(14)))), expected, name);
  const rows = inspectLoweredReplay(directory);
  const csv = readFileSync(path.join(directory, "lowered-replay.csv"), "utf8");
  validateLoweredCsv(csv, rows);
  return { revision: manifest.revision, preliminary, rows: rows.length, columns: columns.length, csvSha256: hash(csv), files: Object.keys(manifest.files).length, audited: rows };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { sample: { type: "string", multiple: true }, out: { type: "string" }, preliminary: { type: "boolean", default: false } } });
  assert.ok(values.sample?.length && values.out);
  const samples = values.sample.map((directory) => auditLoweredReplay(path.resolve(directory), values));
  assert.equal(new Set(samples.map(({ revision }) => revision)).size, 1);
  mkdirSync(values.out);
  writeFileSync(path.join(values.out, "audit.json"), JSON.stringify({ samples }, null, 2), { flag: "wx" });
  console.log(`Audited ${samples.length} samples, ${samples.reduce((sum, sample) => sum + sample.rows, 0)} rows, ${columns.length} columns`);
}
