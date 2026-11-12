import { validateFormalProperties } from "../../web/lib/formal-properties.mjs";

function aliases(module, bit) {
  if (typeof bit === "string") return new Set([`constant:${bit}`]);
  return new Set(Object.entries(module.netnames ?? {}).flatMap(([name, net]) =>
    net.bits.flatMap((candidate, index) => candidate === bit ? [`wire:${name}:${index}`] : [])));
}

export function bindLoweredProperties(replay, original, emitted, { top, clock, edge = "posedge", mode = "bmc" }) {
  const originalInventory = validateFormalProperties(original, original, { top, clock, edge, mode });
  const emittedInventory = validateFormalProperties(emitted, emitted, { top, clock, edge, mode });
  for (const kind of ["assert", "assume"]) {
    if (originalInventory.counts[kind] !== emittedInventory.counts[kind]) {
      throw new Error(`Lowered ${kind} inventory changed`);
    }
  }
  if (emittedInventory.counts.cover !== 0) throw new Error("Icarus replay model still contains cover statements");
  if (originalInventory.registers !== emittedInventory.registers) throw new Error("Lowered state inventory changed");
  const originalTop = original.modules[top];
  const emittedTop = emitted.modules[top];
  const overlaps = (first, second) => [...first].some((alias) => second.has(alias));
  const initial = (module, bit) => Object.values(module.netnames).flatMap((net) => {
    const index = net.bits.indexOf(bit);
    return index < 0 || !net.attributes?.init ? [] : [net.attributes.init.split("").reverse()[index]];
  });
  const usedRegisters = new Set();
  for (const cell of Object.values(originalTop.cells).filter((cell) => cell.type === "$dff")) {
    const matches = Object.entries(emittedTop.cells).filter(([, other]) => other.type === "$dff" &&
      cell.connections.Q.length === other.connections.Q.length && cell.connections.Q.every((bit, index) => {
        const otherBit = other.connections.Q[index];
        return overlaps(aliases(originalTop, bit), aliases(emittedTop, otherBit)) &&
          JSON.stringify([...new Set(initial(originalTop, bit))].sort()) === JSON.stringify([...new Set(initial(emittedTop, otherBit))].sort());
      }));
    if (matches.length !== 1 || usedRegisters.has(matches[0][0])) throw new Error("Lowered state identity, width, or initial value changed");
    usedRegisters.add(matches[0][0]);
  }
  const portSignature = (module) => Object.entries(module.ports).map(([name, port]) =>
    [name, port.direction, port.bits.length]).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(portSignature(originalTop)) !== JSON.stringify(portSignature(emittedTop))) {
    throw new Error("Lowered port inventory changed");
  }
  const used = new Set();
  const mappings = originalInventory.properties.filter(({ kind }) => kind !== "cover").map((property) => {
    const cell = originalTop.cells[property.id];
    const matches = emittedInventory.properties.filter((other) => other.kind === property.kind &&
      ["A", "EN"].every((port) => {
        const expected = aliases(originalTop, cell.connections[port][0]);
        return [...aliases(emittedTop, emittedTop.cells[other.id].connections[port][0])].some((alias) => expected.has(alias));
      }));
    if (matches.length !== 1 || used.has(matches[0].id)) throw new Error("Ambiguous or missing lowered property mapping");
    const [emittedProperty] = matches;
    used.add(emittedProperty.id);
    const match = /^([^:|\r\n]+):(\d+)\.\d+-\d+\.\d+$/.exec(emittedProperty.source);
    if (!match) throw new Error("Invalid lowered property source location");
    return { ...property, emittedId: emittedProperty.id, emittedSource: emittedProperty.source,
      path: match[1], line: Number(match[2]) };
  });
  if (mappings.length !== replay.locations.length || new Set(mappings.map(({ path, line }) => `${path}:${line}`)).size !== mappings.length) {
    throw new Error("Incomplete or ambiguous lowered source locations");
  }
  return { ...replay, locations: mappings, mappings,
    omittedCovers: originalInventory.properties.filter(({ kind }) => kind === "cover") };
}
