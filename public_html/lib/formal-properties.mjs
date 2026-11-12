const propertyTypes = new Map([
  ["$assert", "assert"], ["$assume", "assume"], ["$cover", "cover"],
]);

function requireObject(value, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Invalid formal ${description}`);
  }
  return value;
}

export function inspectFormalDesign(document, top) {
  const modules = requireObject(document?.modules, "modules");
  if (!Object.hasOwn(modules, top)) throw new Error("Missing formal top module");
  if (Object.keys(modules).some((name) => name !== top && !name.startsWith("$"))) {
    throw new Error("Formal design must be flattened before inspection");
  }
  const module = requireObject(modules[top], "top module");
  const cells = requireObject(module.cells, "cells");
  const properties = [];
  const registers = [];
  for (const [id, value] of Object.entries(cells)) {
    const cell = requireObject(value, "cell");
    if (typeof cell.type !== "string") throw new TypeError("Missing formal cell type");
    if (["$check", "$live", "$fair"].includes(cell.type)) {
      throw new Error(`Unsupported or unlowered formal cell: ${cell.type}`);
    }
    const kind = propertyTypes.get(cell.type);
    if (kind) {
      const source = cell.attributes?.src;
      if (typeof source !== "string" || !source.trim()) {
        throw new Error(`Missing formal property source: ${id}`);
      }
      for (const port of ["A", "EN"]) {
        const bits = cell.connections?.[port];
        if (!Array.isArray(bits) || bits.length !== 1 ||
            !bits.every((bit) => Number.isSafeInteger(bit) && bit >= 0 || ["0", "1"].includes(bit))) {
          throw new Error(`Invalid formal property connection: ${id}.${port}`);
        }
      }
      properties.push({ id, kind, source });
    } else if (cell.type === "$dff") {
      const clock = cell.connections?.CLK;
      const polarity = cell.parameters?.CLK_POLARITY;
      if (!Array.isArray(clock) || clock.length !== 1 ||
          !Number.isSafeInteger(clock[0]) || clock[0] < 0 ||
          typeof polarity !== "string" || !/^0*[01]$/.test(polarity)) {
        throw new Error(`Invalid formal register clock: ${id}`);
      }
      registers.push({ id, clock: clock[0], edge: polarity.endsWith("1") ? "posedge" : "negedge" });
    } else if (/^\$(?:.*ff|.*latch|mem|anyinit|sr$)/i.test(cell.type)) {
      throw new Error(`Unsupported formal state cell: ${cell.type}`);
    } else if (Object.hasOwn(modules, cell.type)) {
      throw new Error("Unflattened formal module instance");
    }
  }
  return { properties, registers, ports: requireObject(module.ports, "ports") };
}

export function validateFormalProperties(before, after, { top, clock = null, edge = "posedge", mode = "bmc" }) {
  if (!["bmc", "prove"].includes(mode)) throw new Error("Unsupported formal mode");
  if (!["posedge", "negedge"].includes(edge)) throw new Error("Unsupported formal clock edge");
  const original = inspectFormalDesign(before, top);
  const prepared = inspectFormalDesign(after, top);
  const signature = ({ id, kind, source }) => JSON.stringify([id, kind, source]);
  const expected = original.properties.map(signature).sort();
  const actual = prepared.properties.map(signature).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Formal property identity, type, or source changed during preparation");
  }
  if (!prepared.properties.some(({ kind }) => kind === "assert")) {
    throw new Error("No assertion targets in formal design");
  }
  if (clock !== null) {
    const port = prepared.ports[clock];
    if (!Object.hasOwn(prepared.ports, clock) || port?.direction !== "input" ||
        !Array.isArray(port.bits) || port.bits.length !== 1 || !Number.isSafeInteger(port.bits[0])) {
      throw new Error("Formal clock must be a single-bit input port");
    }
    if (!prepared.registers.length ||
        prepared.registers.some((register) => register.clock !== port.bits[0] || register.edge !== edge)) {
      throw new Error("Formal clock does not match every register");
    }
  } else if (prepared.registers.length) {
    throw new Error("Sequential formal design requires an explicit clock");
  }
  return {
    properties: prepared.properties,
    counts: Object.fromEntries(["assert", "assume", "cover"].map((kind) =>
      [kind, prepared.properties.filter((property) => property.kind === kind).length])),
    clock,
    edge: clock === null ? null : edge,
    registers: prepared.registers.length,
  };
}
