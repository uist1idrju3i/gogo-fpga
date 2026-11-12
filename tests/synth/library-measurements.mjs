import assert from "node:assert/strict";

export function withUnknownPnrCell(netlist) {
  const corrupted = structuredClone(netlist);
  const { cells } = corrupted.modules.top;
  assert.ok(!Object.hasOwn(cells, "S13_NEGATIVE_CONTROL"), "The negative control cell already exists");
  cells.S13_NEGATIVE_CONTROL = {
    hide_name: 0, type: "S13_UNKNOWN_CELL", parameters: {}, attributes: {}, port_directions: {}, connections: {},
  };
  return corrupted;
}

export function assertUnknownPnrCellFailure(row, stderr) {
  assert.ok([1, 125].includes(row.exit_status), "Unexpected negative control exit status");
  assert.ok(!row.signal, "Negative control terminated by a signal");
  assert.ok(!row.execution_error || (row.backend === "wasi" && row.execution_error.name === "WebAssembly.Exception"),
    "Unexpected negative control execution error");
  assert.deepEqual(stderr.split("\n").filter((line) => line.startsWith("ERROR:")), [
    "ERROR: Unable to place cell 'S13_NEGATIVE_CONTROL', no BELs remaining to implement cell type 'S13_UNKNOWN_CELL'",
  ]);
}

export function cpuLoweringCommand(readCommand) {
  return `${readCommand}; hierarchy -top top; setattr -set keep 1 top/w:i_req top/w:i_ack; proc; flatten; memory_map; opt; write_verilog -noattr src/lowered.v; write_json top.json`;
}

export function executionErrorDetails(error) {
  if (error === undefined || error === null) return null;
  return {
    name: error.name ?? (error instanceof WebAssembly.Exception ? "WebAssembly.Exception" : error.constructor?.name ?? typeof error),
    message: error.message ?? String(error),
  };
}

export function isCapacityExceeded(wasi, native, resources) {
  if (!Object.values(resources).some(({ used, total }) => used > total)) return false;
  assert.ok([1, 125].includes(wasi.status) && [1, 125].includes(native.status), "Unexpected capacity exit status");
  assert.ok(!wasi.error || wasi.error instanceof WebAssembly.Exception, "Unexpected WASI failure");
  assert.ifError(native.error);
  assert.ok(!native.signal, "Native nextpnr terminated by a signal");
  const errors = (log) => log.split("\n").filter((line) => line.startsWith("ERROR:"));
  const diagnostics = errors(wasi.stderr);
  assert.deepEqual(diagnostics, errors(native.stderr), "Native/WASI capacity diagnostics differ");
  assert.equal(diagnostics.length, 1, "Expected one capacity diagnostic");
  const exhausted = /^ERROR: Unable to place cell '[^'\r\n]+', no BELs remaining to implement cell type '(\w+)'$/.exec(diagnostics[0]);
  if (exhausted) {
    const bucket = /^LUT[1-4]$/.test(exhausted[1]) ? "LUT4" : exhausted[1];
    const resource = resources[bucket];
    assert.ok(Object.hasOwn(resources, bucket) && resource.used > resource.total,
      "The exhausted BEL bucket has no numeric capacity overflow");
  } else {
    assert.match(diagnostics[0], /^ERROR: Unable to find legal placement for cell \S/);
  }
  return true;
}

export function inspectCpuStructure(netlist) {
  const { cells, ports } = netlist.modules.top;
  const entries = Object.entries(cells);
  const count = (namePattern, type) => entries.filter(([name, cell]) => namePattern.test(name) && type.test(cell.type)).length;
  const result = {
    cpu_cells: count(/^cpu\./, /./),
    cpu_state_cells: count(/^cpu\./, /^DFF/),
    cpu_logic_cells: count(/^cpu\./, /^(LUT[1-4]|ALU)$/),
    ram_state_cells: count(/^memory\.ram(?:\.|\[|$)/, /^(DFF|RAM|DPB$|SDP|SP)/),
    led_bits: ports.led.bits,
  };
  assert.ok(result.cpu_state_cells >= 32, "The mapped CPU has fewer than 32 retained state cells");
  assert.ok(result.cpu_logic_cells >= 16, "The mapped CPU has fewer than 16 retained logic cells");
  assert.ok(result.ram_state_cells > 0, "The mapped CPU RAM was optimized away");
  assert.ok(result.led_bits.length === 1 && Number.isSafeInteger(result.led_bits[0]), "The mapped CPU LED is constant");
  return result;
}

export function parseDeviceUtilization(log, { allowExceeded = false } = {}) {
  const sections = log.split("Info: Device utilisation:");
  assert.equal(sections.length, 2, "Expected one nextpnr device utilization table");
  const resources = {};
  let terminated = false;
  for (const line of sections[1].replace(/\n$/, "").split("\n")) {
    if (/^(?:Info:)?\s*$/.test(line)) {
      if (Object.keys(resources).length > 0) {
        terminated = true;
        break;
      }
      continue;
    }
    const match = /^Info:\s+(\w+):\s+(\d+)\/\s*(\d+)\s+(\d+)%\s*$/.exec(line);
    assert.ok(match, `Malformed device utilization row: ${line}`);
    const [, name, usedText, totalText, percentText] = match;
    assert.ok(!["__proto__", "constructor", "prototype"].includes(name), "Unsafe resource name");
    assert.ok(!Object.hasOwn(resources, name), `Duplicate resource ${name}`);
    const used = Number(usedText);
    const total = Number(totalText);
    assert.ok(Number.isSafeInteger(used) && Number.isSafeInteger(total) && total > 0 && (allowExceeded || total >= used), `Invalid capacity for ${name}`);
    assert.equal(Number(percentText), Math.floor(100 * used / total), `Invalid percentage for ${name}`);
    resources[name] = { used, total };
  }
  assert.ok(terminated, "Unterminated device utilization table");
  for (const name of ["LUT4", "DFF", "BSRAM"]) {
    assert.ok(Object.hasOwn(resources, name) && resources[name].total > 0, `Missing device capacity for ${name}`);
  }
  assert.ok(resources.LUT4.used > 0 && resources.DFF.used > 0, "The representative has no retained logic or state");
  return resources;
}
