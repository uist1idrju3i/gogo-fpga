import assert from "node:assert/strict";

export function verifyGhdlReplayVcd(plan, bytes) {
  const vcd = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const end = /\$enddefinitions\s+\$end\s*/.exec(vcd);
  assert.ok(end, "Missing VCD header");
  const header = vcd.slice(0, end.index);
  let ticksPerNs;
  const scopes = [];
  const declarations = new Map();
  const targets = new Map();
  let roots = 0, consumed = 0;
  for (const item of header.matchAll(/\$(\w+)\b([\s\S]*?)\$end\s*/g)) {
    assert.equal(header.slice(consumed, item.index).trim(), "", "Unknown VCD header text");
    consumed = item.index + item[0].length;
    const [, directive, body] = item;
    const parts = body.trim().split(/\s+/);
    if (directive === "scope") {
      assert.ok(parts.length === 2 && parts[0] === "module", "Invalid VCD scope");
      if (scopes.length === 0 && parts[1] === plan.top) roots++;
      scopes.push(parts[1]);
    } else if (directive === "upscope") {
      assert.ok(scopes.length > 0 && body.trim() === "", "Invalid VCD scope end");
      scopes.pop();
    } else if (directive === "var") {
      assert.ok(parts.length >= 4 && ["reg", "wire", "integer"].includes(parts[0]) && /^\d+$/.test(parts[1]), "Invalid VCD variable");
      const width = Number(parts[1]), id = parts[2];
      assert.ok(Number.isSafeInteger(width) && width > 0 && width <= 4096, "Invalid VCD width");
      assert.ok(!declarations.has(id), "Ambiguous VCD identifier");
      declarations.set(id, { width });
      if (scopes.length === 1 && scopes[0] === plan.top) {
        const name = parts[3].replace(/\[\d+:\d+\]$/, "");
        if (plan.ports.some((port) => port.name === name) || name === plan.clock) {
          assert.ok(!targets.has(name), "Duplicate replay VCD port");
          targets.set(name, { id, width });
        }
      }
    } else if (directive === "timescale") {
      assert.equal(ticksPerNs, undefined, "Duplicate VCD time scale");
      const scale = /^(1|10|100)\s*(fs|ps|ns|us|ms|s)$/.exec(body.trim());
      assert.ok(scale, "Invalid VCD time scale");
      ticksPerNs = 10 ** ({ fs: 6, ps: 3, ns: 0, us: -3, ms: -6, s: -9 }[scale[2]]) / Number(scale[1]);
    } else {
      assert.ok(["date", "version", "comment"].includes(directive), "Unknown VCD directive");
    }
  }
  assert.equal(header.slice(consumed).trim(), "", "Incomplete VCD header");
  assert.ok(Number.isSafeInteger(ticksPerNs) && ticksPerNs > 0, "Missing or unsupported VCD time precision");
  assert.ok(scopes.length === 0 && roots === 1, "Missing or ambiguous replay VCD scope");
  for (const port of plan.ports) assert.equal(targets.get(port.name)?.width, port.width, "Missing or mismatched VCD port");
  if (plan.clock) assert.equal(targets.get(plan.clock)?.width, 1, "Missing VCD clock");
  const values = new Map();
  const clockEvents = [];
  let time = -1, sample = 0;
  const checkUntil = (limit) => {
    while (sample < plan.steps && (10 * sample + 2) * ticksPerNs < limit) {
      for (const port of plan.ports) {
        assert.equal(values.get(targets.get(port.name).id), port.values[sample], `VCD witness mismatch at step ${sample + 1}: ${port.name}`);
      }
      sample++;
    }
  };
  for (const line of vcd.slice(end.index + end[0].length).trim().split(/\r?\n/)) {
    let match;
    if ((match = /^#(\d+)$/.exec(line))) {
      const next = Number(match[1]);
      assert.ok(Number.isSafeInteger(next) && next >= 0 && next > time && next <= plan.endTimeNs * ticksPerNs, "Invalid VCD timestamp");
      if (time === -1) assert.equal(next, 0, "VCD must start at zero");
      checkUntil(next);
      time = next;
    } else {
      assert.ok(time >= 0, "VCD value before timestamp");
      match = /^b([01xXzZ]+)\s+(\S+)$/.exec(line) ?? /^([01xXzZ])(\S+)$/.exec(line);
      assert.ok(match && declarations.has(match[2]), "Unknown VCD value");
      const [, bits, id] = match, { width } = declarations.get(id);
      assert.ok(bits.length <= width, "Oversized VCD value");
      const value = bits.toLowerCase().padStart(width, /^[xz]/i.test(bits) ? bits[0].toLowerCase() : "0");
      values.set(id, value);
      if (plan.clock && targets.get(plan.clock).id === id) clockEvents.push([time, value]);
    }
  }
  assert.equal(time, plan.endTimeNs * ticksPerNs, "Incomplete VCD end timestamp");
  checkUntil(time + 1);
  assert.equal(sample, plan.steps, "Incomplete VCD observations");
  if (plan.clock) {
    const expected = [[0, String(plan.inactive)]];
    for (let ns = 1; ns <= plan.endTimeNs; ns++) {
      if (ns % 10 === 0) expected.push([ns * ticksPerNs, String(1 - plan.inactive)]);
      if (ns % 10 === 5 && ns >= 15) expected.push([ns * ticksPerNs, String(plan.inactive)]);
    }
    assert.deepEqual(clockEvents, expected, "VCD clock does not match the replay schedule");
  }
  return { ticksPerNs };
}
