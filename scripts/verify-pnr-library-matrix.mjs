#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { HDL_LIBRARY_CASES } from "../tests/fixtures/libraries/cases.mjs";
import { CPU_CASES } from "../tests/fixtures/cpus/cases.mjs";
import { cpuBench } from "../tests/fixtures/cpus/bench.mjs";
import { assertCpuFrontendFailure } from "../tests/synth/iverilog-helpers.mjs";
import { assertUnknownPnrCellFailure, inspectCpuStructure, withUnknownPnrCell } from "../tests/synth/library-measurements.mjs";
import { importProjectZip } from "../web/lib/project-zip.mjs";
import { prepareProjectInputs } from "../web/lib/project.mjs";
import { runWasiP1 } from "../web/lib/wasi-p1.mjs";
import { BOARDS } from "../web/lib/boards.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: {
  "matrix-dir": { type: "string" }, out: { type: "string" }, repeats: { type: "string", default: "5" },
  kind: { type: "string", default: "hdl" },
} });
assert.ok(values["matrix-dir"] && values.out, "Required: --matrix-dir COMPLETE_MATRIX --out NEW_DIR");
assert.ok(["hdl", "cpu"].includes(values.kind), "Expected --kind hdl or --kind cpu");
const cpu = values.kind === "cpu";
const repeats = Number(values.repeats);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 5, "At least five repeats are required");
const source = path.resolve(root, values["matrix-dir"]);
const out = path.resolve(root, values.out);
const load = (file) => JSON.parse(readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtures = cpu ? CPU_CASES : HDL_LIBRARY_CASES;
const expected = fixtures.length * BOARDS.length;
const complete = load(path.join(source, "summary.json"));
assert.equal(complete.expected, expected);
assert.equal(complete.passed + (cpu ? complete.capacity_exceeded + complete.frontend_unsupported : 0), expected,
  "The full synthesis/PNR/pack/frontend classification matrix must finish first");
const cases = fixtures.flatMap(({ id, frontendFailure }) => BOARDS.map(({ id: board }) => {
  const directory = path.join(source, id, board);
  const measurement = load(path.join(directory, "measurement.json"));
  assert.equal(measurement.id, id);
  assert.equal(measurement.board, board);
  const status = measurement.status;
  assert.ok(status === "passed" || (cpu && ["capacity-exceeded", "frontend-unsupported"].includes(status)),
    `Unclassified matrix row: ${id}/${board}/${status}`);
  assert.equal(Boolean(frontendFailure), status === "frontend-unsupported");
  assert.equal(hash(readFileSync(path.join(directory, "project.zip"))), measurement.hashes.project_zip);
  for (const value of Object.values(measurement.timings)) assert.ok(Number.isFinite(value) && value > 0);
  if (status === "frontend-unsupported") {
    assert.equal(measurement.frontend_failure.diagnostic, frontendFailure);
    assert.equal(measurement.frontend_failure.native.status, measurement.frontend_failure.wasm.status);
    assert.ok(measurement.frontend_failure.native.status > 0);
    assert.ok(!existsSync(path.join(directory, "top.json")), "Unsupported frontend had a synthesized netlist");
    return { id, board, directory, status, frontendFailure, measurement };
  }
  assert.deepEqual(measurement.mapped_cpu_structure, cpu ? inspectCpuStructure(load(path.join(directory, "top.json"))) : undefined);
  if (cpu) {
    assert.equal(measurement.lowered_execution.positive, "passed");
    assert.equal(measurement.lowered_execution.led_stuck, "rejected");
    assert.deepEqual(measurement.pnr_exit_status, status === "passed" ? { wasi: 0, native: 0 } : { wasi: 1, native: 125 });
    assert.equal(measurement.pnr_errors.native_signal, null);
  }
  if (status === "passed") {
    assert.equal(measurement.hashes.pnr_wasi, measurement.hashes.pnr_native);
    assert.equal(hash(readFileSync(path.join(directory, "pnr.json"))), measurement.hashes.pnr_wasi);
    assert.equal(hash(readFileSync(path.join(directory, "native-pnr.json"))), measurement.hashes.pnr_native);
    assert.equal(hash(readFileSync(path.join(directory, "pyodide.fs"))), measurement.hashes.fs);
    assert.equal(statSync(path.join(directory, "pyodide.fs")).size, measurement.fs_bytes);
  } else {
    assert.ok(Object.values(measurement.resources).some(({ used, total }) => used > total), "No numeric capacity overflow");
    assert.ok(measurement.pnr_errors.wasi?.name && measurement.pnr_errors.wasi?.message,
      "Missing WASI error identity");
    assert.ok(!existsSync(path.join(directory, "pnr.json")), "Capacity failure produced a routed artifact");
  }
  return { id, board, directory, status, measurement, resources: measurement.resources,
    layout: status === "passed" ? hash(JSON.stringify(load(path.join(directory, "pnr.json")))) : "" };
}));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "",
  "Formal measurements require a clean, committed checkout");
const binaryInfo = Object.fromEntries(["native", "wasi"].map((mode) => {
  const directory = path.join(root, "build", mode, "nextpnr");
  const info = load(path.join(directory, "build-info.json"));
  const executable = path.join(directory, `nextpnr-himbaechel-gowin${mode === "wasi" ? ".wasm" : ""}`);
  assert.equal(info.mode, mode);
  assert.equal(info.artifact.sha256, hash(readFileSync(executable)));
  assert.equal(info.artifact.size, statSync(executable).size);
  assert.deepEqual(info.numerics, {
    eigen_definitions: ["EIGEN_DONT_VECTORIZE"], translation_unit: "common/place/placer_heap.cc",
    fp_contract: "off",
  });
  assert.equal(info.build_script_sha256, hash(readFileSync(path.join(root, "scripts/build-pnr-wasm.sh"))));
  for (const [name, digest] of Object.entries(info.build_helpers)) {
    assert.equal(hash(readFileSync(path.join(root, "scripts", name))), digest);
  }
  for (const patch of info.patches) {
    assert.equal(hash(readFileSync(path.join(root, "patches/nextpnr", patch.patch))), patch.patch_sha256);
  }
  for (const chipdb of info.chipdb) {
    const file = path.join(directory, chipdb.path);
    assert.equal(hash(readFileSync(file)), chipdb.sha256);
    assert.equal(statSync(file).size, chipdb.size);
  }
  return [mode, { executable: path.relative(root, executable), sha256: info.artifact.sha256,
    size: info.artifact.size, info_sha256: hash(readFileSync(path.join(directory, "build-info.json"))),
    patches: info.patches, chipdb: info.chipdb, numerics: info.numerics }];
}));
assert.deepEqual(binaryInfo.native.patches, binaryInfo.wasi.patches);
assert.deepEqual(binaryInfo.native.chipdb, binaryInfo.wasi.chipdb);
const sourceHashes = Object.fromEntries([
  "scripts/diagnose-pnr-layout.mjs", "scripts/verify-pnr-library-matrix.mjs",
  "tests/synth/nextpnr-helpers.mjs", "tests/synth/iverilog-helpers.mjs",
  "tests/synth/library-measurements.mjs", "tests/synth/gowin-pack.test.mjs",
  "tests/fixtures/cpus/bench.mjs", "tests/fixtures/cpus/cases.mjs",
].map((file) => [file, hash(readFileSync(path.join(root, file)))]));
mkdirSync(out);
const rows = [];
const manifests = [];
const iverilogRoot = path.resolve(root, process.env.IVERILOG_WASM_DIR ?? "build/iverilog-wasm/output");
const nativeIverilogRoot = path.resolve(root, process.env.IVERILOG_NATIVE_DIR ?? "build/iverilog-native/output");
const iverilogHashes = cpu ? Object.fromEntries(["ivlpp", "ivl", "vvp"].map((name) => [name, {
  native: hash(readFileSync(path.join(nativeIverilogRoot, name))),
  wasi: hash(readFileSync(path.join(iverilogRoot, `${name}.wasm`))),
}])) : null;
const iverilogModules = cpu && cases.some((sample) => sample.frontendFailure) ? Object.fromEntries(
  ["ivlpp", "ivl", "vvp"].map((name) => [name, new WebAssembly.Module(readFileSync(path.join(iverilogRoot, `${name}.wasm`)))]),
) : null;
const iverilogInfo = cpu ? {
  native: load(path.join(nativeIverilogRoot, "../build-info.json")),
  wasi: load(path.join(iverilogRoot, "../build-info.json")),
} : null;
let iverilogVersion = null;
if (cpu) {
  assert.deepEqual(iverilogInfo.native.iverilog, iverilogInfo.wasi.iverilog);
  assert.deepEqual(iverilogInfo.native.patches, iverilogInfo.wasi.patches);
  for (const mode of ["native", "wasi"]) {
    for (const name of ["ivlpp", "ivl", "vvp"]) {
      assert.equal(iverilogInfo[mode].artifacts[`${name}${mode === "wasi" ? ".wasm" : ""}`].sha256,
        iverilogHashes[name][mode]);
    }
    for (const patch of iverilogInfo[mode].patches) assert.equal(hash(readFileSync(path.join(root, patch.path))), patch.sha256);
  }
  const nativeVersion = spawnSync(path.join(nativeIverilogRoot, "vvp"), ["-V"], { encoding: "utf8" });
  assert.ifError(nativeVersion.error);
  assert.equal(nativeVersion.status, 0);
  const wasiVersion = [];
  const result = runWasiP1(iverilogModules.vvp, { args: ["vvp", "-V"],
    stdout: (bytes) => wasiVersion.push(Buffer.from(bytes)), stderr: (bytes) => wasiVersion.push(Buffer.from(bytes)) });
  assert.equal(result.exitCode, 0);
  iverilogVersion = `${nativeVersion.stdout}${nativeVersion.stderr}`.trim();
  assert.equal(Buffer.concat(wasiVersion).toString().trim(), iverilogVersion);
  assert.ok(iverilogVersion.includes(iverilogInfo.native.iverilog.version));
}
const runMetadata = { kind: values.kind, revision, repeats, matrix_dir: path.relative(root, source),
  command: ["node", path.relative(root, import.meta.filename), ...process.argv.slice(2)],
  matrix_sha256: hash(readFileSync(path.join(source, "summary.json"))),
  os: `${os.type()} ${os.release()} ${os.arch()}`, architecture: process.arch, node: process.version,
  cpus: os.cpus().length, memory_bytes: os.totalmem(),
  cpu_model: os.cpus()[0]?.model, available_parallelism: os.availableParallelism(), load_average: os.loadavg(),
  environment: Object.fromEntries(["S5_WASI_ROOT", "S5_NATIVE_ROOT", "IVERILOG_WASM_DIR", "IVERILOG_NATIVE_DIR",
    "EXPERIMENT_CONCURRENT_WORKLOAD"].map((name) => [name, process.env[name] ?? null])),
  submodules: execFileSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" }),
  binary_info: binaryInfo, iverilog_hashes: iverilogHashes, iverilog_info: iverilogInfo,
  iverilog_actual_version: iverilogVersion, source_hashes: sourceHashes,
  criteria: "At least five alternated native/WASI PNR runs for each routed or capacity case. Routed raw bytes, resources, and output must match; capacity must have numeric overflow and identical placement errors. Unsupported frontends require identical real Icarus failures, not fake PNR successes. A/A and negative controls must reject corrupted inputs. Synthesis, lowering, structure and pack measurements are from the prerequisite full matrix and are not repeated here.",
};
writeFileSync(path.join(out, "metadata.json"), JSON.stringify(runMetadata, null, 2), { flag: "wx" });
function record(name, directory, summary, metadata, phase, sample) {
  manifests.push({ name, metadata_sha256: hash(readFileSync(path.join(directory, "metadata.json"))),
    summary_sha256: hash(readFileSync(path.join(directory, "summary.json"))), resources: summary.resources });
  for (const row of summary.rows) rows.push({ ...row, id: sample.id, board: sample.board,
    case_status: sample.status, phase, metadata });
}
async function runFrontend(sample, phase, invalid = false) {
  const name = `${phase}-${sample.id}-${sample.board}`;
  const directory = path.join(out, name);
  mkdirSync(directory);
  const restored = await importProjectZip(readFileSync(path.join(sample.directory, "project.zip")));
  const input = await prepareProjectInputs(restored.project, restored.files);
  const files = [...input.files.filter((file) => /\.(?:v|vh|hex)$/i.test(file.path)),
    { path: "src/tb.v", content: cpuBench() }];
  assert.ok(files.some((file) => file.path.startsWith(`libraries/${sample.id}/sources/`)));
  const meta = { ...runMetadata, purpose: "Classify an actual Icarus frontend error; no synthesis, PNR, capacity or performance claim",
    case: name, project_zip_sha256: sample.measurement.hashes.project_zip,
    hashes: { project_zip: sample.measurement.hashes.project_zip } };
  writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(meta, null, 2), { flag: "wx" });
  const observed = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const repeatDirectory = path.join(directory, `repeat-${repeat}`);
    mkdirSync(repeatDirectory);
    let rejected = false;
    try {
      assertCpuFrontendFailure(repeatDirectory, files, input, iverilogModules,
        invalid ? "NEGATIVE_EXPECTED_DIAGNOSTIC_ABSENT" : sample.frontendFailure);
    } catch (error) {
      if (!invalid) throw error;
      assert.ok(error instanceof assert.AssertionError && error.message.includes(sample.frontendFailure),
        "The frontend negative control failed for a reason other than the intentionally wrong expectation");
      rejected = true;
    }
    assert.equal(rejected, invalid, "Frontend negative control was not rejected");
    const evidence = load(path.join(repeatDirectory, "frontend-results.json"));
    assert.equal(evidence.native.status, evidence.wasm.status);
    assert.equal(evidence.native.stderr, evidence.wasm.stderr);
    assert.equal(evidence.native.stdout, evidence.wasm.stdout);
    assert.ok(evidence.native.stderr.includes(sample.frontendFailure));
    for (const backend of ["native", "wasi"]) observed.push({ repeat, backend,
      status: invalid ? "failed" : "frontend-unsupported", layout_sha256: "", elapsed_ms: null,
      wasi_memory_bytes: null, exit_status: evidence[backend === "wasi" ? "wasm" : "native"].status,
      signal: null, execution_error: null,
      stderr_sha256: hash(evidence.native.stderr) });
  }
  const summary = { failed: invalid, resources: null, cross_backend_same: false, rows: observed };
  writeFileSync(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
  record(name, directory, summary, meta, phase, sample);
  console.log(`${name}: ${invalid ? "wrong expected error rejected" : "frontend unsupported"}`);
}
async function run(sample, phase, invalid = false) {
  if (sample.frontendFailure) return runFrontend(sample, phase, invalid);
  const name = `${phase}-${sample.id}-${sample.board}`;
  const directory = path.join(out, name);
  const result = spawnSync(process.execPath, ["scripts/diagnose-pnr-layout.mjs", "--case-dir", sample.directory,
    "--out", directory, "--board", sample.board, "--repeats", String(repeats),
    ...(sample.status === "capacity-exceeded" && !invalid ? ["--expect-capacity"] : [])], {
    cwd: root, encoding: "utf8", timeout: cpu ? 3600000 : 600000, maxBuffer: 4 * 1024 * 1024,
  });
  writeFileSync(path.join(out, `${name}.stdout.log`), result.stdout ?? "", { flag: "wx" });
  writeFileSync(path.join(out, `${name}.stderr.log`), result.stderr ?? "", { flag: "wx" });
  assert.ifError(result.error);
  assert.equal(result.signal, null, `Diagnostic killed by ${result.signal}: ${name}`);
  assert.equal(result.status, invalid ? 1 : 0, `${result.stderr}\n${result.stdout}`);
  const summary = load(path.join(directory, "summary.json"));
  const metadata = load(path.join(directory, "metadata.json"));
  assert.equal(summary.failed, invalid);
  assert.equal(summary.cross_backend_same, sample.status === "passed" && !invalid);
  assert.equal(summary.rows.length, 2 * repeats);
  if (!invalid) assert.deepEqual(summary.resources, sample.resources);
  assert.equal(metadata.head, revision);
  assert.equal(metadata.working_tree, "");
  assert.equal(metadata.hashes.native, binaryInfo.native.sha256);
  assert.equal(metadata.hashes.wasi, binaryInfo.wasi.sha256);
  assert.equal(metadata.hashes.native_build_info, binaryInfo.native.info_sha256);
  assert.equal(metadata.hashes.wasi_build_info, binaryInfo.wasi.info_sha256);
  assert.equal(metadata.hashes.netlist, hash(readFileSync(path.join(sample.directory, "top.json"))));
  assert.equal(metadata.hashes.cst, hash(readFileSync(path.join(sample.directory, "constraints/board.cst"))));
  const seen = new Set();
  for (const row of summary.rows) {
    assert.ok(["native", "wasi"].includes(row.backend));
    assert.ok(Number.isInteger(row.repeat) && row.repeat >= 1 && row.repeat <= repeats);
    const key = `${row.backend}-${row.repeat}`;
    assert.ok(!seen.has(key), `Repeated result: ${name}/${key}`);
    seen.add(key);
    row.stderr_sha256 = hash(readFileSync(path.join(directory, key, "stderr.log")));
    assert.equal(row.status, invalid ? "failed" : sample.status);
    assert.ok(Number.isFinite(row.elapsed_ms) && row.elapsed_ms > 0);
    if (invalid) {
      assert.equal(row.layout_sha256, "");
      assert.ok(!existsSync(path.join(directory, key, "pnr.json")), "Negative control produced routed output");
      assertUnknownPnrCellFailure(row, readFileSync(path.join(directory, key, "stderr.log"), "utf8"));
    } else if (sample.status === "passed") {
      assert.equal(row.layout_sha256, sample.layout);
      const output = readFileSync(path.join(directory, key, "pnr.json"));
      assert.equal(hash(output), sample.measurement.hashes.pnr_wasi, "Repeated routed JSON bytes differ from the matrix");
      if (row.backend === "wasi") assert.ok(Number.isSafeInteger(row.wasi_memory_bytes) && row.wasi_memory_bytes > 0);
      assert.equal(row.exit_status, 0);
    } else {
      assert.equal(row.layout_sha256, "");
      assert.ok(!existsSync(path.join(directory, key, "pnr.json")), "Capacity failure produced routed output");
      assert.equal(row.exit_status, sample.measurement.pnr_exit_status[row.backend]);
      assert.ok(!row.signal && (row.backend === "native" ? !row.execution_error : row.execution_error?.name === "WebAssembly.Exception"));
      if (row.backend === "wasi") assert.ok(Number.isSafeInteger(row.wasi_memory_bytes) && row.wasi_memory_bytes > 0);
    }
  }
  record(name, directory, summary, metadata, phase, sample);
  console.log(`${name}: ${invalid ? "negative control rejected" : sample.status === "capacity-exceeded" ?
    "matching capacity overflow confirmed" : "strict parity passed"}`);
}

const calibration = cases.find(({ id, board }) =>
  id === (cpu ? "serv" : "verilog-uart") && board === (cpu ? "tangnano4k" : "tangnano1k"));
assert.ok(calibration);
await run(calibration, "aa1");
await run(calibration, "aa2");
function corruptedInput(sample, name) {
  const negative = path.join(out, name);
  mkdirSync(negative);
  mkdirSync(path.join(negative, "constraints"));
  const netlist = withUnknownPnrCell(load(path.join(sample.directory, "top.json")));
  writeFileSync(path.join(negative, "top.json"), JSON.stringify(netlist), { flag: "wx" });
  writeFileSync(path.join(negative, "constraints/board.cst"),
    readFileSync(path.join(sample.directory, "constraints/board.cst")), { flag: "wx" });
  return { ...sample, directory: negative };
}
await run(corruptedInput(calibration, "negative-input"), "negative", true);
if (cpu) {
  const capacity = cases.find(({ id, board }) => id === "serv" && board === "tangnano1k");
  const frontend = cases.find(({ id, board }) => id === "femtorv" && board === "tangnano1k");
  assert.equal(capacity?.status, "capacity-exceeded");
  assert.equal(frontend?.status, "frontend-unsupported");
  await run(capacity, "capacity-aa1");
  await run(capacity, "capacity-aa2");
  await run(corruptedInput(capacity, "negative-capacity-input"), "negative-capacity", true);
  await run(frontend, "frontend-aa1");
  await run(frontend, "frontend-aa2");
  await run(frontend, "negative-frontend", true);
}
for (const sample of cases) await run(sample, "main");

assert.equal(hash(readFileSync(import.meta.filename)), sourceHashes["scripts/verify-pnr-library-matrix.mjs"],
  "Measurement script changed during the trial");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), revision);
assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), "",
  "Checkout changed during the trial");

function statistics(values) {
  assert.equal(values.length, repeats);
  assert.ok(values.every((value) => Number.isFinite(value) && value > 0));
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, minimum: sorted[0], maximum: sorted.at(-1),
    median: (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 };
}
const timingStatistics = cases.filter(({ status }) => status === "passed").map((sample) => {
  const measured = rows.filter((row) => row.phase === "main" && row.id === sample.id && row.board === sample.board);
  const native = measured.filter((row) => row.backend === "native");
  const wasi = measured.filter((row) => row.backend === "wasi");
  return { id: sample.id, board: sample.board, native_ms: statistics(native.map((row) => row.elapsed_ms)),
    wasi_ms: statistics(wasi.map((row) => row.elapsed_ms)),
    wasi_memory_bytes: statistics(wasi.map((row) => row.wasi_memory_bytes)) };
});

const header = ["run_id", "variant", "repeat", "metric", "value", "unit", "valid", "note", "status", "library", "board",
  "layout_sha256", "wasi_memory_bytes", "LUT4_used", "LUT4_total", "DFF_used", "DFF_total", "BSRAM_used", "BSRAM_total",
  "native_binary_sha256", "wasi_binary_sha256", "netlist_sha256", "cst_sha256",
  "case_status", "exit_status", "signal", "execution_error_name", "execution_error_message",
  "stderr_sha256", "project_zip_sha256", "matrix_cpu_cells", "matrix_cpu_state_cells", "matrix_cpu_logic_cells",
  "matrix_ram_state_cells", "matrix_fs_sha256", "matrix_fs_bytes", "matrix_yosys_memory_bytes",
  "matrix_pnr_memory_bytes", "matrix_pack_memory_bytes"];
const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const csv = [header, ...rows.map((row) => {
  const sample = cases.find(({ id, board }) => id === row.id && board === row.board);
  const resources = row.phase.startsWith("negative") ? {} : sample.resources ?? {};
  const frontend = sample.status === "frontend-unsupported";
  const valid = row.status === "passed";
  return [`${row.phase}-${row.id}-${row.board}`, row.backend, row.repeat,
    frontend ? "frontend_rejection" : "pnr_elapsed", row.elapsed_ms, "ms",
    valid, row.phase.startsWith("negative") ? "expected rejection; invalid performance sample" :
      frontend ? "Icarus frontend failure only; no synthesis, PNR, capacity or performance claim" :
      row.status === "capacity-exceeded" ? "classification only; not a performance sample" :
      "execution only; excludes module compilation",
    row.status, row.id, row.board, row.layout_sha256, row.wasi_memory_bytes,
    ...["LUT4", "DFF", "BSRAM"].flatMap((name) => [resources[name]?.used, resources[name]?.total]),
    row.metadata.hashes.native, row.metadata.hashes.wasi, row.metadata.hashes.netlist, row.metadata.hashes.cst,
    row.case_status, row.exit_status, row.signal, row.execution_error?.name, row.execution_error?.message,
    row.stderr_sha256, sample.measurement.hashes.project_zip,
    sample.measurement.mapped_cpu_structure?.cpu_cells, sample.measurement.mapped_cpu_structure?.cpu_state_cells,
    sample.measurement.mapped_cpu_structure?.cpu_logic_cells, sample.measurement.mapped_cpu_structure?.ram_state_cells,
    sample.measurement.hashes.fs, sample.measurement.fs_bytes, sample.measurement.yosys_memory_bytes,
    sample.measurement.pnr_memory_bytes, sample.measurement.pack_memory_bytes];
})].map((row) => row.map(escape).join(",")).join("\n") + "\n";
assert.ok(Buffer.byteLength(csv) < 1024 * 1024, "The raw CSV exceeds the experiment-record limit");
writeFileSync(path.join(out, "results.csv"), csv, { flag: "wx" });
writeFileSync(path.join(out, "summary.json"), JSON.stringify({ expected, verified_cases: cases.length,
  passed: cases.filter(({ status }) => status === "passed").length,
  routed_cases: cases.filter(({ status }) => status === "passed").length,
  capacity_cases: cases.filter(({ status }) => status === "capacity-exceeded").length,
  frontend_cases: cases.filter(({ status }) => status === "frontend-unsupported").length,
  repeats, calibration_executions: (cpu ? 12 : 4) * repeats,
  rejected_executions: (cpu ? 6 : 2) * repeats,
  measured_executions: expected * 2 * repeats, timing_statistics: timingStatistics, load_average_end: os.loadavg(),
  script_sha256: hash(readFileSync(import.meta.filename)), csv_sha256: hash(csv), manifests }, null, 2), { flag: "wx" });
