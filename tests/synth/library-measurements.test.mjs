import assert from "node:assert/strict";
import test from "node:test";
import { assertUnknownPnrCellFailure, executionErrorDetails, inspectCpuStructure, isCapacityExceeded, parseDeviceUtilization, withUnknownPnrCell } from "./library-measurements.mjs";

const log = "Info: Device utilisation:\nInfo: LUT4: 217/ 1152 18%\nInfo: DFF: 81/ 864 9%\nInfo: BSRAM: 0/ 4 0%\nInfo:\n";

test("unknown-cell controls leave existing LUT and wide-mux topology unchanged", () => {
  const netlist = { modules: { top: { cells: {
    lut: { type: "LUT4", connections: { F: [4] } },
    mux: { type: "MUX2_LUT5", connections: { I0: [4], O: [5] } },
  }, ports: { led: { direction: "output", bits: [5] } } } } };
  const snapshot = structuredClone(netlist);
  const corrupted = withUnknownPnrCell(netlist);
  assert.deepEqual(netlist, snapshot);
  assert.equal(corrupted.modules.top.cells.S13_NEGATIVE_CONTROL.type, "S13_UNKNOWN_CELL");
  assert.deepEqual(corrupted.modules.top.cells.S13_NEGATIVE_CONTROL.connections, {});
  delete corrupted.modules.top.cells.S13_NEGATIVE_CONTROL;
  assert.deepEqual(corrupted, snapshot);
  const collision = withUnknownPnrCell(netlist);
  assert.throws(() => withUnknownPnrCell(collision), /already exists/);
  assert.throws(() => withUnknownPnrCell({ modules: {} }));
});

test("unknown-cell controls reject unrelated diagnostics, crashes, and successful exits", () => {
  const diagnostic = "ERROR: Unable to place cell 'S13_NEGATIVE_CONTROL', no BELs remaining to implement cell type 'S13_UNKNOWN_CELL'\n";
  const native = { backend: "native", exit_status: 125, signal: null, execution_error: null };
  const wasi = { backend: "wasi", exit_status: 1, signal: null,
    execution_error: { name: "WebAssembly.Exception", message: "[object WebAssembly.Exception]" } };
  assertUnknownPnrCellFailure(native, diagnostic);
  assertUnknownPnrCellFailure(wasi, `Info: negative control\n${diagnostic}0 warnings, 1 error\n`);
  for (const [row, stderr] of [
    [native, diagnostic.replace("S13_NEGATIVE_CONTROL", "another_cell")],
    [native, diagnostic.replace("S13_UNKNOWN_CELL", "LUT4")],
    [native, "ERROR: Bad MUX2 node:cpu.lut\n"],
    [native, `${diagnostic}ERROR: unrelated failure\n`],
    [native, "Info: S13_UNKNOWN_CELL\n"],
    [{ ...native, exit_status: 0 }, diagnostic],
    [{ ...native, exit_status: 127 }, diagnostic],
    [{ ...native, signal: "SIGABRT" }, diagnostic],
    [{ ...native, execution_error: { name: "WebAssembly.Exception" } }, diagnostic],
    [{ ...wasi, execution_error: { name: "RuntimeError" } }, diagnostic],
  ]) assert.throws(() => assertUnknownPnrCellFailure(row, stderr), assert.AssertionError);
});

test("serialized execution errors retain JavaScript and WebAssembly exception identity", () => {
  assert.equal(executionErrorDetails(undefined), null);
  assert.equal(executionErrorDetails(null), null);
  assert.deepEqual(executionErrorDetails(new Error("spawn failed")), { name: "Error", message: "spawn failed" });
  assert.deepEqual(executionErrorDetails(new WebAssembly.RuntimeError("out of bounds")), { name: "RuntimeError", message: "out of bounds" });
  const exception = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
  assert.deepEqual(JSON.parse(JSON.stringify(executionErrorDetails(exception))), {
    name: "WebAssembly.Exception", message: String(exception),
  });
});

test("resource measurements retain exact used and available counts", () => {
  assert.deepEqual(parseDeviceUtilization(log), {
    LUT4: { used: 217, total: 1152 }, DFF: { used: 81, total: 864 }, BSRAM: { used: 0, total: 4 },
  });
});

test("unparseable, absent, repeated, exceeded, or optimized-away resources fail closed", () => {
  for (const broken of [
    "", log + log, log.replace("LUT4", "UNKNOWN"), log.replace("217/ 1152", "1153/ 1152"),
    log.replace("217/ 1152", "0/ 1152"), log.replace("81/ 864", "0/ 864"),
    log.replace("BSRAM: 0/ 4", "BSRAM: invalid"),
    log.replace("Info:\n", "Info: DSP: invalid\nInfo:\n"),
    log.replace("Info:\n", "Info: DSP: 0/ 0 0%\nInfo:\n"),
    log.replace("Info:\n", "Info: __proto__: 1/ 10 10%\nInfo:\n"),
    log.replace("18%", "19%"), log.replace("Info:\n", ""),
    log.replace("Info: DFF", "Info: LUT4: 1/ 10 10%\nInfo: DFF"),
  ]) assert.throws(() => parseDeviceUtilization(broken), assert.AssertionError);
});

test("explicit capacity diagnostics retain exceeded counts without relaxing table validation", () => {
  const exceeded = log.replace("217/ 1152 18%", "1153/ 1152 100%");
  assert.equal(parseDeviceUtilization(exceeded, { allowExceeded: true }).LUT4.used, 1153);
  assert.throws(() => parseDeviceUtilization(exceeded), assert.AssertionError);
  for (const broken of [exceeded.replace("100%", "99%"), exceeded.replace("Info:\n", ""), exceeded.replace("BSRAM: 0/ 4", "BSRAM: 0/ 0")]) {
    assert.throws(() => parseDeviceUtilization(broken, { allowExceeded: true }), assert.AssertionError);
  }
});

test("capacity classification requires matching diagnostics and rejects traps, signals, and unrelated errors", () => {
  const resources = { LUT4: { used: 1322, total: 1152 } };
  const stderr = "ERROR: Unable to find legal placement for cell cpu.cell\n";
  const wasi = { status: 1, stderr };
  const native = { status: 125, stderr, signal: null };
  assert.equal(isCapacityExceeded(wasi, native, resources), true);
  const exception = new WebAssembly.Exception(new WebAssembly.Tag({ parameters: [] }), []);
  assert.equal(isCapacityExceeded({ ...wasi, error: exception }, native, resources), true);
  assert.equal(isCapacityExceeded(wasi, native, { LUT4: { used: 100, total: 1152 } }), false);
  for (const [badWasi, badNative] of [
    [{ ...wasi, status: 0 }, native], [wasi, { ...native, status: 0 }],
    [{ ...wasi, status: 9 }, native], [wasi, { ...native, status: null }],
    [{ ...wasi, error: new WebAssembly.RuntimeError("out of bounds") }, native],
    [wasi, { ...native, error: new Error("spawn failed") }],
    [wasi, { ...native, signal: "SIGSEGV" }],
    [{ ...wasi, stderr: "" }, native],
    [{ ...wasi, stderr: `${stderr}ERROR: unrelated failure\n` }, native],
    [{ ...wasi, stderr: "ERROR: unrelated failure\n" }, { ...native, stderr: "ERROR: unrelated failure\n" }],
  ]) assert.throws(() => isCapacityExceeded(badWasi, badNative, resources), assert.AssertionError);
});

test("BEL exhaustion requires matching diagnostics and overflow of the named resource bucket", () => {
  const resources = { LUT4: { used: 1153, total: 1152 }, DFF: { used: 10, total: 864 } };
  const stderr = "ERROR: Unable to place cell 'cpu.DPTR_DFFE_Q_1_D_LUT4_F', no BELs remaining to implement cell type 'LUT4'\n";
  const wasi = { status: 1, stderr };
  const native = { status: 125, stderr, signal: null };
  assert.equal(isCapacityExceeded(wasi, native, resources), true);
  for (const broken of [stderr.replace("'LUT4'", "'DFF'"), stderr.replace("'LUT4'", "'UNKNOWN'"),
    stderr.replace("'LUT4'", "'__proto__'"), stderr.replace("no BELs remaining", "unrelated failure"),
    `${stderr.trimEnd()} unexpected text\n`]) {
    assert.throws(() => isCapacityExceeded({ ...wasi, stderr: broken }, { ...native, stderr: broken }, resources), assert.AssertionError);
  }
  assert.throws(() => isCapacityExceeded(wasi, { ...native, stderr: stderr.replace("cpu.DPTR", "cpu.other") }, resources), /diagnostics differ/);
});

test("LUT1 through LUT4 exhaustion requires overflow of the upstream Gowin LUT4 BEL bucket", () => {
  const resources = { LUT4: { used: 2604, total: 1152 }, DFF: { used: 639, total: 864 } };
  const run = (type, counts = resources) => {
    const stderr = `ERROR: Unable to place cell 'cpu.cell', no BELs remaining to implement cell type '${type}'\n`;
    return isCapacityExceeded({ status: 1, stderr }, { status: 125, stderr, signal: null }, counts);
  };
  for (const type of ["LUT1", "LUT2", "LUT3", "LUT4"]) {
    assert.equal(run(type), true);
    assert.throws(() => run(type, { LUT4: { used: 1, total: 1152 }, DFF: { used: 865, total: 864 } }), /bucket/);
    assert.throws(() => run(type, { LUT3: resources.LUT4, DFF: resources.DFF }), /bucket/);
    assert.throws(() => run(type, { LUT3: resources.LUT4, LUT4: { used: 1, total: 1152 } }), /bucket/);
    assert.equal(run(type, { LUT4: { used: 1152, total: 1152 } }), false);
  }
  for (const type of ["LUT0", "LUT5", "LUT04", "lut3", "LUT4_extra", "DFF", "UNKNOWN", "__proto__", "constructor"]) {
    assert.throws(() => run(type), assert.AssertionError);
  }
});

test("mapped CPU inspection rejects missing CPU state, RAM, and constant outputs", () => {
  const cells = Object.fromEntries([
    ...Array.from({ length: 32 }, (_, index) => [`cpu.state.${index}`, { type: "DFF" }]),
    ...Array.from({ length: 16 }, (_, index) => [`cpu.logic.${index}`, { type: "LUT4" }]),
    ["memory.ram.0.0", { type: "RAM16SDP4" }],
  ]);
  const netlist = { modules: { top: { cells, ports: { led: { bits: [3] } } } } };
  assert.deepEqual(inspectCpuStructure(netlist), {
    cpu_cells: 48, cpu_state_cells: 32, cpu_logic_cells: 16, ram_state_cells: 1, led_bits: [3],
  });
  for (const [name, type] of [["memory.ram[0]_DFFE_Q_0", "DFFE"], ["memory.ram.0.0", "SDPX9B"], ["memory.ram", "DPB"]]) {
    const changed = structuredClone(netlist);
    delete changed.modules.top.cells["memory.ram.0.0"];
    changed.modules.top.cells[name] = { type };
    assert.equal(inspectCpuStructure(changed).ram_state_cells, 1);
  }
  for (const [name, type] of [["memory.ram_backup.0", "DFF"], ["memory.ramification[0]", "RAM16SDP4"], ["memory.ram[0]", "LUT4"]]) {
    const broken = structuredClone(netlist);
    delete broken.modules.top.cells["memory.ram.0.0"];
    broken.modules.top.cells[name] = { type };
    assert.throws(() => inspectCpuStructure(broken), /RAM was optimized away/);
  }
  for (const name of ["cpu.state.0", "cpu.logic.0", "memory.ram.0.0"]) {
    const broken = structuredClone(netlist);
    delete broken.modules.top.cells[name];
    assert.throws(() => inspectCpuStructure(broken), assert.AssertionError);
  }
  const broken = structuredClone(netlist);
  broken.modules.top.ports.led.bits = ["0"];
  assert.throws(() => inspectCpuStructure(broken), assert.AssertionError);
});
