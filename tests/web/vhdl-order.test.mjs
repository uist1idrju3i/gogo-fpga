import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeVhdlDesign,
  getVhdlLibrary,
  orderVhdlFiles,
} from "../../web/lib/vhdl-order.mjs";

const file = (path, content) => ({ path, content });

test("named libraries qualify unit identities and work aliases without rewriting source", () => {
  const alphaPackage = { ...file("alpha/pkg.vhd", "package cfg is end;"), library: "Alpha" };
  const betaPackage = { ...file("beta/pkg.vhd", "package cfg is end;"), library: "beta" };
  const alphaChild = { ...file("alpha/child.vhd", "use work.cfg.all; entity child is end;"), library: "alpha" };
  const betaChild = { ...file("beta/child.vhd", "use work.cfg.all; entity child is end;"), library: "beta" };
  const top = file("src/top.vhd", "entity top is end; architecture rtl of top is begin a: entity alpha.child; b: entity beta.child; end;");
  const before = JSON.stringify([top, betaChild, alphaChild, betaPackage, alphaPackage]);
  const result = orderVhdlFiles([top, betaChild, alphaChild, betaPackage, alphaPackage]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.order, [betaPackage, betaChild, alphaPackage, alphaChild, top]);
  assert.equal(JSON.stringify([top, betaChild, alphaChild, betaPackage, alphaPackage]), before);
});

test("duplicate primary and secondary units fail only within the same logical library", () => {
  const one = file("src/one.vhd", "entity top is end; architecture rtl of top is begin end;");
  for (const content of ["entity top is end;", "architecture rtl of top is begin end;"]) {
    const result = orderVhdlFiles([one, file("src/two.vhd", content)]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0].message, /Duplicate work design unit/);
  }
  const different = file("src/two.vhd", "entity other is end; architecture rtl of other is begin end;");
  assert.equal(orderVhdlFiles([one, different]).ok, true);
  assert.equal(orderVhdlFiles([one, { ...one, path: "alpha/one.vhd", library: "alpha" }]).ok, true);
});

test("named-library missing dependencies and cycles remain fail closed", () => {
  const missing = { ...file("alpha/a.vhd", "use work.missing.all; entity a is end;"), library: "alpha" };
  assert.match(orderVhdlFiles([missing]).errors[0].message, /Unresolved alpha reference "missing"/);
  const a = { ...file("alpha/a.vhd", "package cfg is use beta.cfg.all; end;"), library: "alpha" };
  const b = { ...file("beta/b.vhd", "package cfg is use alpha.cfg.all; end;"), library: "beta" };
  const result = orderVhdlFiles([a, b]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(({ message }) => /dependency cycle/.test(message)));
});

test("library names are case-insensitive basic identifiers rather than paths or options", () => {
  assert.equal(getVhdlLibrary({}), "work");
  assert.equal(getVhdlLibrary({ library: "Open_Logic" }), "open_logic");
  for (const library of [null, 3, "", "../escape", "--work=alpha", "trailing_", "two__underscores"]) {
    assert.throws(() => getVhdlLibrary({ library }), /Invalid VHDL library/);
  }
});

test("orders package, package body, entity and architecture dependencies", () => {
  const architecture = file(
    "src/top.vhd",
    "entity top is end entity;\nuse work.cfg.all;\n" +
      "architecture rtl of top is\nbegin\n  u: entity work.child;\nend architecture;\n",
  );
  const child = file("src/child.vhd", "entity child is end entity;\n");
  const body = file(
    "src/pkg-body.vhd",
    "package body cfg is end package body;\n",
  );
  const packageUnit = file(
    "src/pkg.vhd",
    "package cfg is end package;\n",
  );
  const result = orderVhdlFiles([architecture, child, body, packageUnit]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(
    result.order.map(({ path }) => path),
    ["src/child.vhd", "src/pkg.vhd", "src/top.vhd", "src/pkg-body.vhd"],
  );
});

test("preserves input order for unrelated files and ignores non-work libraries", () => {
  const first = file("src/first.vhd", "use ieee.std_logic_1164.all;\nentity first is end;\n");
  const second = file("src/second.vhd", "library vendor; use vendor.parts.all;\nentity second is end;\n");
  const result = orderVhdlFiles([first, second]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, [first, second]);
});

test("ignores declarations and references inside comments and literals", () => {
  const source = file(
    "src/top.vhd",
    [
      "-- entity missing is end;",
      "/* use work.fake.all; architecture a of fake is */",
      'entity top is constant s : string := "use work.ghost.all;"; end entity;',
      "architecture rtl of top is constant c : character := 'x'; begin null; end;",
    ].join("\n"),
  );
  const result = orderVhdlFiles([source]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.order, [source]);
});

test("reports unresolved work references with the source line", () => {
  const result = orderVhdlFiles([
    file("src/top.vhd", "entity top is end;\nuse work.missing.all;\n"),
  ]);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{
    file: "src/top.vhd",
    line: 2,
    message: 'Unresolved work reference "missing"',
  }]);
});

test("reports file dependency cycles with filenames and source lines", () => {
  const result = orderVhdlFiles([
    file("src/a.vhd", "package a is use work.b.all; end;"),
    file("src/b.vhd", "package b is use work.a.all; end;"),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(({ message, line }) =>
    message.includes("src/a.vhd") &&
    message.includes("src/b.vhd") &&
    Number.isInteger(line)
  ));
});

test("orders context and configuration dependencies", () => {
  const top = file("src/top.vhd", "configuration top_cfg of top is end;");
  const context = file("src/context.vhd", "context common is end context;");
  const entity = file("src/entity.vhd", "entity top is end entity;\ncontext work.common;\n");
  const result = orderVhdlFiles([top, entity, context]);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.order.map(({ path }) => path),
    ["src/context.vhd", "src/entity.vhd", "src/top.vhd"],
  );
});

test("identifies VHDL entities instantiated by other VHDL units", () => {
  const files = [
    file("src/top.vhd", "entity top is end;\narchitecture rtl of top is begin u: entity work.child; end;"),
    file("src/child.vhd", "entity child is end;"),
  ];
  const units = analyzeVhdlDesign(files);
  const instantiated = new Set(
    units.flatMap(({ references }) =>
      references
        .filter(({ usage }) => usage === "instantiation")
        .map(({ name }) => name)
    ),
  );
  assert.deepEqual(
    units.flatMap(({ declarations }) =>
      declarations
        .filter(({ kind, name }) => kind === "entity" && !instantiated.has(name))
        .map(({ name }) => name)
    ),
    ["top"],
  );
});
