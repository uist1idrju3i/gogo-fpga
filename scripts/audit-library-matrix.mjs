import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { CPU_CASES } from '../tests/fixtures/cpus/cases.mjs';
import { HDL_LIBRARY_CASES } from '../tests/fixtures/libraries/cases.mjs';
import { BOARDS } from '../web/lib/boards.mjs';
import { prepareLibrarySelection } from '../web/lib/libraries.mjs';
import { isCapacityExceeded, inspectCpuStructure, parseDeviceUtilization } from '../tests/synth/library-measurements.mjs';

const root = path.resolve(import.meta.dirname, '..');
const [kind, input, output, expectedRevision] = process.argv.slice(2);
assert.ok(['cpu', 'hdl'].includes(kind));
assert.ok(input && output && /^[0-9a-f]{40}$/.test(expectedRevision));
const base = path.resolve(root, input);
const out = path.resolve(output);
assert.ok(!existsSync(out) && !existsSync(`${out}.csv`));
const load = (file) => JSON.parse(readFileSync(file, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixtures = kind === 'cpu' ? CPU_CASES : HDL_LIBRARY_CASES;
const summary = load(path.join(base, 'summary.json'));
const catalog = load(path.join(base, 'assets/catalog.json'));
assert.equal(summary.expected, fixtures.length * BOARDS.length);
assert.equal(summary.passed + summary.capacity_exceeded + summary.frontend_unsupported, summary.expected);
const rows = [];
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink());
    return entry.isDirectory() ? filesBelow(file) : [file];
  });
}
function flatten(value, prefix = '', flat = {}) {
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, flat);
  } else flat[prefix] = value;
  return flat;
}
for (const fixture of fixtures) for (const board of BOARDS) {
  const directory = path.join(base, fixture.id, board.id);
  const m = load(path.join(directory, 'measurement.json'));
  assert.equal(m.id, fixture.id);
  assert.equal(m.component, fixture.component);
  assert.equal(m.board, board.id);
  assert.ok(['passed', 'capacity-exceeded', 'frontend-unsupported'].includes(m.status));
  assert.ok(!m.error);
  const entry = catalog.entries.find(({ id }) => id === fixture.id);
  const state = entry.components.find(({ id }) => id === fixture.component).boards[board.id];
  assert.equal(state, m.status === 'passed' ? 'confirmed' : m.status);
  const rejected = m.status !== 'passed';
  assert.deepEqual(m.selection, {
    catalog_state: state, require_confirmed: !rejected, normal_selection_rejected: rejected,
  });
  const select = () => prepareLibrarySelection(catalog, { id: fixture.id, component: fixture.component },
    (asset) => readFileSync(path.join(base, 'assets', asset.asset)), { board: board.id });
  if (rejected) await assert.rejects(select, /このボードでは選択できません/);
  else await select();
  assert.equal(m.hashes.project_zip, hash(readFileSync(path.join(directory, 'project.zip'))));
  Object.values(m.timings).forEach((v) => assert.ok(Number.isFinite(v) && v > 0));
  const artifacts = Object.fromEntries(filesBelow(directory).map((file) => [path.relative(directory, file), {
    size: statSync(file).size, sha256: hash(readFileSync(file)),
  }]));
  const diagnostics = Object.fromEntries(Object.keys(artifacts).filter((name) => /(?:stderr|stdout)(?:\.log)?$|\.log$/.test(name)).map((name) => {
    const content = readFileSync(path.join(directory, name), 'utf8');
    return [name, content.split('\n').filter((line) => /warning|error|critical|failed|unsupported/i.test(line))];
  }));
  if (m.status === 'frontend-unsupported') {
    assert.equal(m.frontend_failure.diagnostic, fixture.frontendFailure);
    assert.deepEqual(m.frontend_failure.wasm, m.frontend_failure.native);
    assert.ok(m.frontend_failure.native.status > 0);
    assert.ok(m.frontend_failure.native.stderr.includes(fixture.frontendFailure));
    for (const name of ['top.json', 'pnr.json', 'pyodide.fs']) assert.ok(!existsSync(path.join(directory, name)));
  } else {
    for (const [key, name] of [['yosys_wasi', 'top.json'], ['yosys_native', 'native-top.json']]) {
      assert.equal(m.hashes[key], artifacts[name].sha256);
    }
    const wasiLog = readFileSync(path.join(directory, 'wasi.stderr'), 'utf8');
    const nativeLog = readFileSync(path.join(directory, 'native-pnr.stderr'), 'utf8');
    assert.deepEqual(parseDeviceUtilization(wasiLog, { allowExceeded: true }), m.resources);
    assert.deepEqual(parseDeviceUtilization(nativeLog, { allowExceeded: true }), m.resources);
    for (const [key, value] of Object.entries(m)) if (key.endsWith('_memory_bytes')) assert.ok(Number.isSafeInteger(value) && value > 0);
    assert.equal(m.pnr_errors.native_signal, null);
    if (kind === 'cpu') {
      assert.deepEqual(inspectCpuStructure(load(path.join(directory, 'top.json'))), m.mapped_cpu_structure);
      assert.equal(m.lowered_execution.positive, 'passed');
      assert.equal(m.lowered_execution.led_stuck, 'rejected');
      assert.equal(m.lowered_execution.netlistHash, artifacts['lowered-top.json'].sha256);
    }
    if (m.status === 'passed') {
      assert.equal(m.hashes.pnr_wasi, artifacts['pnr.json'].sha256);
      assert.equal(m.hashes.pnr_native, artifacts['native-pnr.json'].sha256);
      assert.equal(m.hashes.pnr_native, m.hashes.pnr_wasi);
      assert.equal(m.hashes.fs, artifacts['pyodide.fs'].sha256);
      assert.equal(m.hashes.fs, artifacts['native/top.fs'].sha256);
      assert.equal(m.fs_bytes, artifacts['pyodide.fs'].size);
      assert.deepEqual(m.pnr_exit_status, { wasi: 0, native: 0 });
      assert.equal(m.pnr_errors.wasi, null);
      assert.equal(m.pnr_errors.native, null);
      assert.ok(!/^ERROR:/m.test(wasiLog));
      assert.ok(!/^ERROR:/m.test(nativeLog));
    } else {
      assert.deepEqual(m.pnr_exit_status, { wasi: 1, native: 125 });
      assert.equal(m.pnr_errors.wasi.name, 'WebAssembly.Exception');
      assert.equal(m.pnr_errors.native, null);
      assert.ok(isCapacityExceeded({ status: 1, stderr: wasiLog }, { status: 125, stderr: nativeLog, signal: null }, m.resources));
      for (const name of ['pnr.json', 'native-pnr.json', 'pyodide.fs']) assert.ok(!existsSync(path.join(directory, name)));
    }
  }
  rows.push({ measurement: m, artifacts, diagnostics });
}
const counts = Object.fromEntries(['passed', 'capacity-exceeded', 'frontend-unsupported'].map((status) => [status, rows.filter((row) => row.measurement.status === status).length]));
assert.equal(counts.passed, summary.passed);
assert.equal(counts['capacity-exceeded'], summary.capacity_exceeded);
assert.equal(counts['frontend-unsupported'], summary.frontend_unsupported);
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const inputs = ['tests/fixtures', 'tests/synth', 'web/lib', 'libraries', 'patches', 'vendor', 'third_party',
  'scripts/build-*.sh', 'scripts/build-info.py', 'scripts/verify-pnr-library-matrix.mjs', '.gitmodules'];
assert.equal(execFileSync('git', ['diff', '--name-only', expectedRevision, head, '--', ...inputs],
  { cwd: root, encoding: 'utf8' }), '', 'Matrix inputs differ from the recorded source revision');
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }), '');
const flats = rows.map(({ measurement }) => flatten(measurement));
const columns = [...new Set(flats.flatMap((row) => Object.keys(row)))].sort();
const cell = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = `${[columns, ...flats.map((row) => columns.map((key) => row[key]))].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
const record = { kind, head, source_revision: expectedRevision, summary, counts, columns, rows_read: rows.length,
  values_read: flats.reduce((total, row) => total + Object.keys(row).length, 0),
  csv_values: rows.length * columns.length, csv_sha256: hash(csv),
  catalog_sha256: hash(readFileSync(path.join(base, 'assets/catalog.json'))), rows };
writeFileSync(`${out}.csv`, csv, { flag: 'wx' });
writeFileSync(out, JSON.stringify(record, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ out, sha256: hash(readFileSync(out)), head, counts,
  rows_read: record.rows_read, values_read: record.values_read, csv_values: record.csv_values,
  csv_sha256: record.csv_sha256, catalog_sha256: record.catalog_sha256 }));
