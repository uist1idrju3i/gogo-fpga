import assert from "node:assert/strict";
import test from "node:test";
import { createLibraryFixture as fixture, createLibraryProject } from "./library-fixture.mjs";
import { changeProjectLibraries, prepareProjectInputs } from "../../web/lib/project.mjs";
import {
  inspectInstalledLibraries, libraryHash, libraryManifestText,
  librarySnapshotPath, prepareLibrarySelection, resolveLibraryClosure,
  validateLibrarySelections,
  validateCompileOptions, verilogReadCommand,
} from "../../web/lib/libraries.mjs";

test("library closure is ordered, namespaced and free of duplicate shared dependencies", async () => {
  const { catalog, selection } = await fixture();
  const result = resolveLibraryClosure(catalog, [selection, { id: "dependency", component: "rtl" }], { board: "tangnano1k" });
  assert.deepEqual(result.ordered.map(({ entry }) => entry.id), ["dependency", "primary"]);
  assert.equal(result.manifest.entries.length, 2);
  assert.deepEqual(resolveLibraryClosure(catalog, [], { board: "tangnano1k" }).ordered, []);
});

test("library closure rejects cycles, missing dependencies, revision mismatches and define conflicts", async () => {
  for (const mutation of [
    (catalog) => catalog.entries[1].components[0].dependencies.push("primary/rtl"),
    (catalog) => catalog.entries[0].components[0].dependencies.push("missing/rtl"),
    (catalog) => {
      catalog.entries[0].components[0].defines.FLAG = 1;
      catalog.entries[1].components[0].defines.FLAG = 2;
    },
  ]) {
    const { catalog, selection } = await fixture();
    mutation(catalog);
    assert.throws(() => resolveLibraryClosure(catalog, [selection], { board: "tangnano1k" }), /ライブラリー/);
  }
  const { catalog, selection } = await fixture();
  assert.throws(() => resolveLibraryClosure(catalog, [{ ...selection, revision: "3".repeat(40) }]), /固定版/);
});

test("unconfirmed, unsupported, capacity-exceeded and implicit deprecated selections fail closed", async () => {
  for (const status of ["unverified", "capacity-exceeded", "frontend-unsupported"]) {
    const { catalog, selection } = await fixture();
    catalog.entries[0].components[0].boards.tangnano1k = status;
    assert.throws(() => resolveLibraryClosure(catalog, [selection], { board: "tangnano1k" }), /選択できません/);
  }
  const { catalog, selection } = await fixture();
  catalog.entries[1].deprecated = true;
  assert.throws(() => resolveLibraryClosure(catalog, [selection], { board: "tangnano1k" }), /明示的/);
  assert.equal(resolveLibraryClosure(catalog, [selection, { id: "dependency", component: "rtl" }], { board: "tangnano1k" }).ordered.length, 2);
});

test("frontend-unsupported components retain board evidence without becoming selectable", async () => {
  const { catalog, selection } = await fixture();
  const entry = catalog.entries[0];
  entry.status = "frontend-unsupported";
  const boards = entry.components[0].boards;
  for (const board of Object.keys(boards)) boards[board] = "frontend-unsupported";
  assert.throws(() => resolveLibraryClosure(catalog, [selection], { board: "tangnano1k" }), /選択できません/);
  assert.equal(resolveLibraryClosure(catalog, []).ordered.length, 0);
  for (const state of ["confirmed", "unverified", "capacity-exceeded"]) {
    boards.tangnano1k = state;
    assert.throws(() => resolveLibraryClosure(catalog, []), /状態が一致しません/);
  }
  entry.components = [];
  assert.throws(() => resolveLibraryClosure(catalog, []), /状態が一致しません/);
});

test("installed libraries retain original source and license bytes and can match the current catalog", async () => {
  const { catalog, prepare } = await fixture();
  const installed = await prepare();
  assert.equal(installed.files.size, 5);
  const project = { libraries: [installed.selection] };
  const inspected = await inspectInstalledLibraries(project, installed.files, catalog);
  assert.equal(inspected.records[0].matched, true);
  assert.deepEqual(inspected.sources.map(({ path }) => path), [
    "libraries/dependency/sources/rtl/unit.v", "libraries/primary/sources/rtl/unit.v",
  ]);
  assert.equal((await inspectInstalledLibraries(project, installed.files)).records[0].matched, false);
});

test("portable snapshots preserve old sources without silently adopting a changed upstream", async () => {
  const { catalog, prepare } = await fixture();
  const installed = await prepare();
  catalog.entries[0].source.revision = "9".repeat(40);
  const result = await inspectInstalledLibraries({ libraries: [installed.selection] }, installed.files, catalog);
  assert.equal(result.records[0].matched, false);
  assert.equal(result.records[0].revision, "1".repeat(40));
});

test("library downloads, stored sources and manifests reject hash mismatches and unexpected files", async () => {
  const { catalog, selection, prepare } = await fixture();
  await assert.rejects(prepareLibrarySelection(catalog, selection, async () => new Uint8Array(), { board: "tangnano1k" }), /ハッシュ/);
  for (const mutate of [
    (files) => files.set("libraries/primary/sources/rtl/unit.v", "tampered"),
    (files) => files.delete("libraries/dependency/sources/LICENSE"),
    (files) => files.set("libraries/primary/sources/unregistered.v", "module secret; endmodule"),
    (files) => files.set(librarySnapshotPath("primary", "rtl"), "{}"),
  ]) {
    const installed = await prepare();
    mutate(installed.files);
    await assert.rejects(inspectInstalledLibraries({ libraries: [installed.selection] }, installed.files), /ライブラリー/);
  }
});

test("a ZIP self-declared hash does not establish a catalog match", async () => {
  const { catalog, prepare } = await fixture();
  const installed = await prepare();
  const path = librarySnapshotPath("primary", "rtl");
  const manifest = JSON.parse(installed.files.get(path));
  manifest.entries.find(({ id }) => id === "primary").source.url = "https://untrusted.test/fork";
  const text = libraryManifestText(manifest);
  installed.files.set(path, text);
  installed.selection.manifestHash = await libraryHash(text);
  const result = await inspectInstalledLibraries({ libraries: [installed.selection] }, installed.files, catalog);
  assert.equal(result.records[0].matched, false);
});

test("library metadata rejects traversal, remote asset substitution, unsupported HDL and unsafe defines", async () => {
  for (const mutate of [
    (entry) => entry.components[0].sources[0].path = "../escape.v",
    (entry) => entry.components[0].sources[0].asset = "https://untrusted.test/design",
    (entry) => entry.components[0].sources[0].language = "systemverilog",
    (entry) => entry.components[0].sources[0].library = "work",
    (entry) => entry.components[0].includeDirectories.push("../outside"),
    (entry) => entry.components[0].defines.FLAG = "1; exec anything",
    (entry) => entry.components[0].parameters = null,
    (entry) => entry.components[0].parameters = { WIDTH: 8 },
    (entry) => entry.components[0].parameters = { "bad name": "8" },
    (entry) => entry.components[0].parameters = { WIDTH: "8\n" },
  ]) {
    const { catalog, selection } = await fixture();
    mutate(catalog.entries[0]);
    assert.throws(() => resolveLibraryClosure(catalog, [selection], { board: "tangnano1k" }), /ライブラリー/);
  }
  assert.equal(validateLibrarySelections([{ id: "../bad" }]).length, 1);
});

test("library download budgets include manifests and license assets before fetching bytes", async () => {
  for (const oversize of [false, true]) {
    const { catalog, selection } = await fixture();
    if (oversize) catalog.entries[0].license.files[0].size = 16 * 1024 * 1024;
    else catalog.entries[0].license.files = Array.from({ length: 256 }, (_, index) => ({
      ...catalog.entries[0].license.files[0], path: `LICENSE-${index}`, asset: `primary/LICENSE-${index}`,
    }));
    let fetched = false;
    await assert.rejects(prepareLibrarySelection(catalog, selection, async () => { fetched = true; }, { board: "tangnano1k" }), /現在 \d+ (件|バイト)/);
    assert.equal(fetched, false);
  }
});

test("removing a selection prunes stale artifacts and unused dependencies but retains shared sources and licenses", async () => {
  const { project, files, catalog, contents } = await createLibraryProject();
  project.files.push({ path: "build/top.fs" });
  files.set("build/top.fs", new Uint8Array([1, 2, 3]));
  const add = await prepareLibrarySelection(catalog, { id: "dependency", component: "rtl" }, async ({ asset }) => contents.get(asset), { board: "tangnano1k" });
  const shared = await changeProjectLibraries(project, files, { add });
  assert.equal(shared.files.has("build/top.fs"), false);
  assert.equal(files.has("build/top.fs"), true);
  const remaining = await changeProjectLibraries(shared.project, shared.files, { remove: { id: "primary", component: "rtl" } });
  assert.equal(remaining.files.has("libraries/primary/sources/LICENSE"), false);
  assert.equal(remaining.files.has("libraries/dependency/sources/LICENSE"), true);
  const empty = await changeProjectLibraries(remaining.project, remaining.files, { remove: { id: "dependency", component: "rtl" } });
  assert.deepEqual(empty.project.libraries, []);
  assert.equal([...empty.files.keys()].some((path) => path.startsWith("libraries/")), false);
});

test("synthesis and simulation use the same verified closure without compiling license or snapshot files", async () => {
  const { project, files } = await createLibraryProject();
  project.files.push({ path: "rom/program.bin" });
  files.set("rom/program.bin", new Uint8Array([0, 255, 1]));
  const synthesis = await prepareProjectInputs(project, files);
  const simulation = await prepareProjectInputs(project, files, { simulation: true });
  for (const input of [synthesis, simulation]) {
    assert.deepEqual(input.files.filter(({ role }) => role === "source").map(({ path }) => path), ["libraries/dependency/sources/rtl/unit.v", "libraries/primary/sources/rtl/unit.v"]);
    assert.equal(input.files.some(({ path }) => path.endsWith("LICENSE") || path.includes("/snapshots/")), false);
    assert.deepEqual(input.files.find(({ path }) => path === "rom/program.bin").content, files.get("rom/program.bin"));
  }
  assert.equal(synthesis.files.some(({ path }) => path === "src/top_tb.v"), false);
  assert.equal(simulation.files.some(({ path }) => path === "src/top_tb.v"), true);
});

test("Yosys option tokens remain unquoted while source paths are quoted and injection is rejected", () => {
  const options = { includeDirectories: ["libraries/primary/sources/rtl"], defines: { FLAG: "4'hc" } };
  const command = verilogReadCommand(["src/top.v"], options);
  assert.equal(command, `read_verilog -Ilibraries/primary/sources/rtl -DFLAG=4'hc "src/top.v"`);
  assert.equal(verilogReadCommand(["src/top.v"], { defines: { MESSAGE: '"A"' } }), 'read_verilog -DMESSAGE="A" "src/top.v"');
  for (const invalid of [
    { defines: { FLAG: "1; shell" } }, { defines: { FLAG: '"; shell' } }, { defines: { FLAG: "1\nshell" } },
    { defines: { FLAG: "1\\nshell" } }, { defines: { FLAG: Infinity } }, { includeDirectories: ["../escape"] },
  ]) {
    assert.throws(() => validateCompileOptions(invalid));
  }
  assert.throws(() => verilogReadCommand(["src/top.v; shell"]));
});
