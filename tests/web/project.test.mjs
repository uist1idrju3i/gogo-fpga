import assert from "node:assert/strict";
import test from "node:test";
import {
  findConstraintBoardMismatch,
  validatePath,
  validateProject,
} from "../../web/lib/project.mjs";

const validProject = {
  version: 4,
  libraries: [],
  name: "blink",
  board: "tangnano9k",
  top: "top",
  files: [{ path: "src/top.v" }, { path: "src/top.vhd" }],
  simulation: { top: "top_tb", files: null, timeLimitSeconds: 10 },
  formal: null,
};

test("project schema accepts the supported shape", () => {
  assert.deepEqual(validateProject(validProject), { ok: true, errors: [] });
  assert.equal(
    validateProject({ ...validProject, vhdlStandard: "2019" }).ok,
    true,
  );
  assert.equal(
    validateProject({ ...validProject, vhdlStandard: "1993" }).ok,
    false,
  );
});

test("project schema rejects unknown keys and versions", () => {
  const unknownKey = validateProject({ ...validProject, extra: true });
  assert.equal(unknownKey.ok, false);
  assert.match(unknownKey.errors.join(" "), /未対応の項目/);

  const wrongVersion = validateProject({ ...validProject, version: 3 });
  assert.equal(wrongVersion.ok, false);
  assert.match(wrongVersion.errors.join(" "), /版は 4/);
});

test("project schema validates simulation settings and selected Verilog files", () => {
  assert.deepEqual(validateProject(validProject), { ok: true, errors: [] });
  for (const simulation of [
    { ...validProject.simulation, extra: true },
    { ...validProject.simulation, files: ["src/missing.v"] },
    { ...validProject.simulation, files: ["src/top.vhd"] },
    { ...validProject.simulation, files: ["src/top.v", "src/top.v"] },
    { ...validProject.simulation, timeLimitSeconds: 0 },
    { ...validProject.simulation, timeLimitSeconds: 121 },
    { ...validProject.simulation, timeLimitSeconds: 1.5 },
  ]) {
    assert.equal(validateProject({ ...validProject, simulation }).ok, false);
  }
  assert.equal(
    validateProject({
      ...validProject,
      simulation: { top: "tb", files: ["src/top.v"], timeLimitSeconds: 120 },
    }).ok,
    true,
  );
});

test("project schema validates formal settings and selected HDL files", () => {
  const formal = {
    engine: "smtbmc",
    solver: "yices2",
    mode: "bmc",
    depth: 20,
    timeoutSeconds: 30,
    memoryMiB: 512,
    top: "top",
    clock: "clk",
    edge: "posedge",
    files: ["src/top.v"],
    sby: null,
  };
  assert.equal(
    validateProject({ ...validProject, formal }).ok,
    true,
  );
  assert.equal(
    validateProject({
      ...validProject,
      files: [...validProject.files, { path: "formal/top.sby" }],
      formal: { ...formal, sby: "formal/top.sby", files: null },
    }).ok,
    true,
  );
  const badSolvers = [
    { ...formal, solver: "missing" },
    { ...formal, solver: null },
    { ...formal, engine: "yosys-sat" },
    { ...formal, engine: "yosys-sat", solver: null, mode: "cover" },
    { ...formal, mode: "live" },
    { ...formal, depth: 0 },
    { ...formal, depth: 1001 },
    { ...formal, timeoutSeconds: 301 },
    { ...formal, memoryMiB: 32 },
    { ...formal, top: "not valid!" },
    { ...formal, clock: "bad name" },
    { ...formal, edge: "both" },
    { ...formal, files: ["src/missing.v"] },
    { ...formal, files: ["src/top.vhd", "src/top.vhd"] },
    { ...formal, files: ["src/top.cst"] },
    { ...formal, extra: true },
    { ...formal, sby: "src/top.v" },
    { ...formal, sby: "formal/missing.sby" },
  ];
  for (const broken of badSolvers) {
    assert.equal(
      validateProject({ ...validProject, formal: broken }).ok,
      false,
      JSON.stringify(broken),
    );
  }
});

test("project schema rejects unknown boards and duplicate paths", () => {
  const unknownBoard = validateProject({ ...validProject, board: "unknown" });
  assert.equal(unknownBoard.ok, false);
  assert.match(unknownBoard.errors.join(" "), /ボード/);

  const duplicate = validateProject({
    ...validProject,
    files: [{ path: "src/top.v" }, { path: "src/top.v" }],
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.errors.join(" "), /複数登録/);
});

test("constraint board mismatch detection handles matching, mismatched, and missing constraints", () => {
  assert.equal(
    findConstraintBoardMismatch({
      ...validProject,
      files: [{ path: "constraints/tangnano9k.cst" }],
    }),
    null,
  );
  assert.deepEqual(
    findConstraintBoardMismatch({
      ...validProject,
      board: "tangnano4k",
      files: [{ path: "constraints/tangnano1k.cst" }],
    }),
    {
      path: "constraints/tangnano1k.cst",
      boardId: "tangnano1k",
      boardName: "Tang Nano 1K",
    },
  );
  assert.equal(findConstraintBoardMismatch(validProject), null);
});

test("validatePath accepts relative supported files", () => {
  assert.deepEqual(validatePath("src/top.v"), { ok: true, errors: [] });
  assert.deepEqual(validatePath("docs/research/oss-survey.md"), {
    ok: true,
    errors: [],
  });
  assert.deepEqual(validatePath("build/top.json"), { ok: true, errors: [] });
});

test("validatePath rejects traversal, empty segments, drive paths, and extensions", () => {
  for (const path of ["../x.v", "a//b.v", "C:\\x.v", "/src/top.v", "src/top.exe", "project.json"]) {
    assert.equal(validatePath(path).ok, false, path);
  }
});

test("ROM files and reserved library paths are supported without widening user file paths", () => {
  for (const path of ["rom/main.bin", "rom/main.hex", "rom/main.mem", "rom/main.dat", "libraries/example/sources/LICENSE", "libraries/example/snapshots/rtl.json"]) {
    assert.equal(validatePath(path).ok, true, path);
  }
  assert.equal(validatePath("libraries/unregistered.v").ok, false);
  assert.equal(validateProject({ ...validProject, libraries: [{ id: "../bad" }] }).ok, false);
  assert.equal(validateProject({ ...validProject, files: [{ path: "src/top.v" }, { path: "src/top.v/other.v" }] }).ok, false);
});

test("validatePath enforces the path length and segment alphabet", () => {
  assert.equal(validatePath(`${"a".repeat(125)}.v`).ok, true);
  assert.equal(validatePath(`${"a".repeat(127)}.v`).ok, false);
  assert.equal(validatePath("src/名前.v").ok, false);
  assert.equal(validatePath("src/top.V").ok, false);
});
