#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { BOARDS } from "../web/lib/boards.mjs";
import { parseDeviceUtilization } from "../tests/synth/library-measurements.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  sample: { type: "string", multiple: true }, "expect-mismatch": { type: "string", multiple: true, default: [] },
  out: { type: "string" },
} });
assert.ok(values.sample?.length && values.out, "Required: --sample NAME=DIRECTORY --out NEW_DIRECTORY");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const layout = (bytes) => hash(JSON.stringify(JSON.parse(bytes)));
const cell = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const columns = ["repeat", "backend", "status", "layout_sha256", "elapsed_ms", "wasi_memory_bytes",
  "exit_status", "signal", "execution_error_name", "execution_error_message"];
const samples = {};
const csvRows = [];
const summarize = (numbers) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return { min: sorted[0], median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2,
    max: sorted.at(-1) };
};
for (const specification of values.sample) {
  const match = /^([a-z0-9-]+)=(.+)$/.exec(specification);
  assert.ok(match, "Expected NAME=DIRECTORY");
  const [, name, directory] = match;
  assert.ok(!Object.hasOwn(samples, name) && !["constructor", "prototype", "__proto__"].includes(name));
  const source = path.resolve(root, directory);
  const metadata = load(path.join(source, "metadata.json"));
  const summary = load(path.join(source, "summary.json"));
  const board = BOARDS.find(({ id }) => id === metadata.board);
  assert.ok(board && Number.isSafeInteger(metadata.repeats) && metadata.repeats >= 5);
  assert.equal(summary.failed, false);
  assert.equal(summary.rows.length, metadata.repeats * 2);
  for (const [key, file] of Object.entries({ native: metadata.native_binary, wasi: metadata.wasm_binary,
    native_chipdb: path.join(metadata.shares.native, `himbaechel/gowin/chipdb-${board.nextpnrFamily}.bin`),
    wasi_chipdb: path.join(metadata.shares.wasi, `himbaechel/gowin/chipdb-${board.nextpnrFamily}.bin`) })) {
    assert.equal(hash(readFileSync(path.resolve(root, file))), metadata.hashes[key], `Changed provenance: ${name}/${key}`);
  }
  assert.equal(metadata.hashes.native_chipdb, metadata.hashes.wasi_chipdb);
  for (const [backend, binary] of [["native", metadata.native_binary], ["wasi", metadata.wasm_binary]]) {
    if (metadata.hashes[`${backend}_build_info`] !== null) {
      assert.equal(hash(readFileSync(path.resolve(root, path.dirname(binary), "build-info.json"))), metadata.hashes[`${backend}_build_info`]);
    }
  }
  const seen = new Set();
  const layouts = {};
  const diagnostics = [];
  for (const row of summary.rows) {
    assert.ok(["native", "wasi"].includes(row.backend));
    assert.ok(Number.isSafeInteger(row.repeat) && row.repeat >= 1 && row.repeat <= metadata.repeats);
    const id = `${row.backend}-${row.repeat}`;
    assert.ok(!seen.has(id));
    seen.add(id);
    assert.equal(row.status, "passed");
    assert.equal(row.exit_status, 0);
    assert.equal(row.signal, null);
    assert.equal(row.execution_error, null);
    assert.ok(!row.error && Number.isFinite(row.elapsed_ms) && row.elapsed_ms > 0);
    if (row.backend === "native") assert.equal(row.wasi_memory_bytes, null);
    else assert.ok(Number.isSafeInteger(row.wasi_memory_bytes) && row.wasi_memory_bytes > 0);
    const run = path.join(source, id);
    assert.deepEqual(load(path.join(run, "result.json")), row);
    assert.equal(hash(readFileSync(path.join(run, "top.json"))), metadata.hashes.netlist);
    assert.equal(hash(readFileSync(path.join(run, "constraints/board.cst"))), metadata.hashes.cst);
    assert.equal(layout(readFileSync(path.join(run, "pnr.json"))), row.layout_sha256);
    if (layouts[row.backend]) assert.equal(row.layout_sha256, layouts[row.backend]);
    layouts[row.backend] = row.layout_sha256;
    for (const stream of ["stdout", "stderr"]) {
      const log = readFileSync(path.join(run, `${stream}.log`), "utf8");
      assert.ok(!/^ERROR:/m.test(log));
      diagnostics.push({ run: id, stream, sha256: hash(log),
        warnings: log.split("\n").filter((line) => /warning|error|critical|failed|unsupported/i.test(line)) });
      if (stream === "stderr") assert.deepEqual(parseDeviceUtilization(log), summary.resources);
    }
    csvRows.push([name, row.repeat, row.backend, row.status, row.layout_sha256, row.elapsed_ms, row.wasi_memory_bytes,
      row.exit_status, row.signal, row.execution_error?.name, row.execution_error?.message]);
  }
  const expectedCsv = columns.join(",") + "\n" + csvRows.filter(([series]) => series === name)
    .map((row) => row.slice(1).map(cell).join(",")).join("\n") + "\n";
  assert.equal(readFileSync(path.join(source, "results.csv"), "utf8"), expectedCsv, "CSV cells differ from audited runs");
  const equal = layouts.native === layouts.wasi;
  assert.equal(summary.cross_backend_same, equal);
  assert.equal(equal, !values["expect-mismatch"].includes(name), `Unexpected strict parity verdict: ${name}`);
  const timings = Object.fromEntries(["native", "wasi"].map((backend) => [backend,
    summarize(summary.rows.filter((row) => row.backend === backend).map((row) => row.elapsed_ms))]));
  const original = readFileSync(path.join(source, "native-1/pnr.json"));
  const changed = JSON.parse(original);
  const placed = Object.values(changed.modules.top.cells).find((cell) => typeof cell.attributes?.NEXTPNR_BEL === "string");
  assert.ok(placed, "No placed cell for the value-changing negative control");
  placed.attributes.NEXTPNR_BEL += "-negative-control";
  assert.throws(() => assert.equal(layout(original), layout(JSON.stringify(changed))), /AssertionError/);
  const reordered = Object.fromEntries(Object.entries(JSON.parse(original)).reverse());
  assert.throws(() => assert.equal(layout(original), layout(JSON.stringify(reordered))), /AssertionError/);
  samples[name] = { source: directory, source_revision: metadata.head, diff_sha256: metadata.diff_sha256,
    hashes: metadata.hashes, binary_bytes: metadata.binary_bytes,
    versions: { native: metadata.nextpnr_version, wasi: metadata.wasi_nextpnr_version },
    repeats: metadata.repeats, layouts, cross_backend_same: equal, timings_ms: timings,
    wasi_memory_bytes: summarize(summary.rows.filter((row) => row.backend === "wasi").map((row) => row.wasi_memory_bytes)),
    resources: summary.resources, negative_controls: { changed_value: "rejected", changed_key_order: "rejected" }, diagnostics };
}
assert.equal(new Set(values["expect-mismatch"]).size, values["expect-mismatch"].length);
for (const name of values["expect-mismatch"]) assert.ok(Object.hasOwn(samples, name), "Unknown mismatch sample");
const out = path.resolve(root, values.out);
mkdirSync(out);
writeFileSync(path.join(out, "results.csv"), [["sample", ...columns], ...csvRows].map((row) => row.map(cell).join(",")).join("\n") + "\n", { flag: "wx" });
writeFileSync(path.join(out, "audit.json"), JSON.stringify({ rows: csvRows.length, columns: columns.length + 1, samples }, null, 2), { flag: "wx" });
console.log(`Audited ${csvRows.length} rows, ${columns.length + 1} columns, strict parity and two negative controls per sample`);
