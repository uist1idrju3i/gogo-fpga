import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import test, { before } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const upstream = path.join(root, "vendor/nextpnr/common/place/placer_heap.cc");
const patchFile = path.join(root, "patches/nextpnr/0002-stabilize-equal-coordinate-cuts.patch");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

before(() => mkdirSync(path.join(root, "build"), { recursive: true }));

test("the isolated numeric probe records flags and never overwrites original linker dependencies", () => {
  const directory = mkdtempSync(path.join(root, "build/t5-pnr-probe-check-"));
  let passed = false;
  try {
    const build = path.join(directory, "build");
    const target = path.join(build, "himbaechel/uarch/gowin");
    const cmake = path.join(target, "CMakeFiles/nextpnr-himbaechel-gowin.dir");
    mkdirSync(path.join(cmake, "common/place"), { recursive: true });
    const source = path.join(directory, "source");
    mkdirSync(path.join(source, "common/place"), { recursive: true });
    writeFileSync(path.join(source, "common/place/placer_heap.cc"), "original source");
    writeFileSync(path.join(build, "CMakeCache.txt"), `CMAKE_HOME_DIRECTORY:INTERNAL=${source}\n`);
    mkdirSync(path.join(build, "share"));
    const compiler = path.join(directory, "cxx");
    writeFileSync(compiler, `#!/usr/bin/env python3
import pathlib, sys
args = sys.argv[1:]
if args == ["--version"]:
    print("isolated-probe-test")
else:
    pathlib.Path(args[args.index("-o") + 1]).write_text("candidate")
    for arg in args:
        if arg.startswith("-Wl,--dependency-file="):
            pathlib.Path(arg.split("=", 1)[1]).write_text("candidate dependency")
`);
    chmodSync(compiler, 0o755);
    const original = path.join(build, "nextpnr-himbaechel-gowin");
    const dependency = path.join(cmake, "link.d");
    writeFileSync(original, "original binary");
    writeFileSync(dependency, "original dependency");
    const object = "CMakeFiles/nextpnr-himbaechel-gowin.dir/common/place/placer_heap.cc.o";
    writeFileSync(path.join(target, object), "original object");
    writeFileSync(path.join(cmake, "flags.make"), "CXX_DEFINES = \nCXX_INCLUDES = \nCXX_FLAGS = -O3\n");
    writeFileSync(path.join(cmake, "link.txt"), `${compiler} -Wl,--dependency-file=CMakeFiles/nextpnr-himbaechel-gowin.dir/link.d ${object} -o ../../../nextpnr-himbaechel-gowin\n`);
    const out = path.join(directory, "candidate");
    const args = [path.join(root, "scripts/build-pnr-scalar-probe.py"), "--build-dir", build,
      "--out", out, "--fp-contract", "off", "--march", "x86-64-v3"];
    const result = spawnSync("python3", args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(readFileSync(path.join(out, "result.json")));
    assert.ok(metadata.compile.includes("-ffp-contract=off"));
    assert.ok(metadata.compile.includes("-march=x86-64-v3"));
    assert.ok(metadata.link.includes(`-Wl,--dependency-file=${out}/link.d`));
    assert.equal(readFileSync(path.join(out, "link.d"), "utf8"), "candidate dependency");
    assert.equal(readFileSync(dependency, "utf8"), "original dependency");
    assert.equal(readFileSync(original, "utf8"), "original binary");
    assert.equal(readFileSync(path.join(target, object), "utf8"), "original object");
    assert.equal(spawnSync("python3", args).status, 1, "Existing diagnostic output must not be overwritten");
    assert.equal(spawnSync("python3", [...args, "--fp-contract", "invalid"]).status, 2);
    passed = true;
  } finally {
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained nextpnr probe evidence: ${directory}`);
  }
});

test("diagnostic evidence audit checks every CSV cell, provenance, execution and strict layout", () => {
  const directory = mkdtempSync(path.join(root, "build/t5-pnr-audit-check-"));
  let passed = false;
  try {
    const input = path.join(directory, "input");
    const shares = path.join(directory, "share");
    mkdirSync(input);
    mkdirSync(path.join(shares, "himbaechel/gowin"), { recursive: true });
    const chipdb = path.join(shares, "himbaechel/gowin/chipdb-GW2A-18C.bin");
    writeFileSync(chipdb, "fixture chipdb");
    const binary = path.join(directory, "binary");
    writeFileSync(binary, "fixture binary");
    const digest = (value) => createHash("sha256").update(value).digest("hex");
    const layout = JSON.stringify({ creator: "fixture", modules: { top: { cells: { cell: { attributes: { NEXTPNR_BEL: "X1Y1/LUT0" } } } } } });
    const metadata = { board: "tangnano20k", repeats: 5, native_binary: binary, wasm_binary: binary,
      shares: { native: shares, wasi: shares }, hashes: { native: digest("fixture binary"), wasi: digest("fixture binary"),
        native_chipdb: digest("fixture chipdb"), wasi_chipdb: digest("fixture chipdb"),
        native_build_info: null, wasi_build_info: null, netlist: digest("{}"), cst: digest("fixture cst") } };
    const resources = { LUT4: { used: 1, total: 100 }, DFF: { used: 1, total: 100 }, BSRAM: { used: 0, total: 10 } };
    const log = "Info: Device utilisation:\nInfo: LUT4: 1/100 1%\nInfo: DFF: 1/100 1%\nInfo: BSRAM: 0/10 0%\n\n";
    const rows = [];
    for (let repeat = 1; repeat <= 5; repeat++) for (const backend of ["native", "wasi"]) {
      const run = path.join(input, `${backend}-${repeat}`);
      mkdirSync(path.join(run, "constraints"), { recursive: true });
      const row = { repeat, backend, status: "passed", layout_sha256: digest(layout), elapsed_ms: 1,
        wasi_memory_bytes: backend === "wasi" ? 65536 : null, exit_status: 0, signal: null, execution_error: null };
      rows.push(row);
      for (const [name, content] of Object.entries({ "top.json": "{}", "constraints/board.cst": "fixture cst", "pnr.json": layout,
        "stdout.log": "", "stderr.log": log, "result.json": JSON.stringify(row) })) writeFileSync(path.join(run, name), content);
    }
    const summary = { failed: false, rows, resources, cross_backend_same: true };
    const csv = "repeat,backend,status,layout_sha256,elapsed_ms,wasi_memory_bytes,exit_status,signal,execution_error_name,execution_error_message\n"
      + rows.map((row) => [row.repeat, row.backend, row.status, row.layout_sha256, row.elapsed_ms, row.wasi_memory_bytes, row.exit_status,
        row.signal, null, null].map((value) => `"${value ?? ""}"`).join(",")).join("\n") + "\n";
    writeFileSync(path.join(input, "metadata.json"), JSON.stringify(metadata));
    writeFileSync(path.join(input, "summary.json"), JSON.stringify(summary));
    writeFileSync(path.join(input, "results.csv"), csv);
    let sequence = 0;
    const run = (...extra) => spawnSync(process.execPath, [path.join(root, "scripts/audit-pnr-diagnostics.mjs"),
      "--sample", `fixture=${input}`, "--out", path.join(directory, `out-${sequence++}`), ...extra], { encoding: "utf8" });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    const report = JSON.parse(readFileSync(path.join(directory, "out-0/audit.json")));
    assert.equal(report.rows, 10);
    assert.equal(report.columns, 11);
    assert.deepEqual(report.samples.fixture.negative_controls, { changed_value: "rejected", changed_key_order: "rejected" });
    assert.equal(run("--expect-mismatch", "fixture").status, 1);
    assert.equal(run("--expect-mismatch", "missing").status, 1);
    writeFileSync(path.join(input, "results.csv"), csv.replace('"passed"', '"failed"'));
    assert.equal(run().status, 1, "Changed CSV status must not pass");
    writeFileSync(path.join(input, "results.csv"), csv);
    writeFileSync(path.join(input, "native-1/pnr.json"), layout.replace("LUT0", "LUT1"));
    assert.equal(run().status, 1, "Changed placed cell must not pass");
    writeFileSync(path.join(input, "native-1/pnr.json"), layout);
    writeFileSync(binary, "changed binary");
    assert.equal(run().status, 1, "Changed binary provenance must not pass");
    writeFileSync(binary, "fixture binary");
    rows[0].exit_status = 1;
    writeFileSync(path.join(input, "summary.json"), JSON.stringify(summary));
    assert.equal(run().status, 1, "Nonzero execution must not pass");
    passed = true;
  } finally {
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained nextpnr audit evidence: ${directory}`);
  }
});

test("nextpnr numeric metadata requires scalar Eigen and explicit uncontracted placer arithmetic", () => {
  const directory = mkdtempSync(path.join(root, "build/t5-pnr-numerics-check-"));
  let passed = false;
  try {
    mkdirSync(path.join(directory, "patched"));
    const source = path.join(directory, "patched/placer_heap.cc");
    writeFileSync(source, "");
    const database = path.join(directory, "compile_commands.json");
    const verify = (entries) => {
      writeFileSync(database, JSON.stringify(entries));
      return spawnSync("python3", ["-c", `
import importlib.util, json
from pathlib import Path
spec = importlib.util.spec_from_file_location("pnr_info", ${JSON.stringify(path.join(root, "scripts/build-pnr-info.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.compiler_metadata(Path(${JSON.stringify(directory)}))))
`], { encoding: "utf8" });
    };
    const entry = { directory, file: "patched/placer_heap.cc", arguments: ["c++", "-DEIGEN_DONT_VECTORIZE", "-DEIGEN_MPL2_ONLY", "-ffp-contract=off", "-c", source] };
    const expected = { translation_unit: "common/place/placer_heap.cc", eigen_definitions: ["EIGEN_DONT_VECTORIZE", "EIGEN_MPL2_ONLY"], fp_contract: "off" };
    for (const candidate of [entry, { directory, file: source, command: `c++ -DEIGEN_DONT_VECTORIZE -DEIGEN_MPL2_ONLY -ffp-contract=off -c ${JSON.stringify(source)}` }]) {
      const result = verify([candidate]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), expected);
    }
    for (const entries of [
      [], [entry, entry], [{ ...entry, file: "patched/globals.cc" }],
      ...[[], ["-DEIGEN_DONT_VECTORIZE=0"], ["-DEIGEN_DONT_VECTORIZE=1"],
        ["-DEIGEN_DONT_VECTORIZE", "-DEIGEN_DONT_VECTORIZE"],
        ["-DEIGEN_DONT_VECTORIZE", "-UEIGEN_DONT_VECTORIZE"],
        ["-DEIGEN_DONT_VECTORIZE", "-U", "EIGEN_DONT_VECTORIZE"],
        "c++ -DEIGEN_DONT_VECTORIZE",
      ].map((arguments_) => [{ ...entry, arguments: arguments_ }]),
    ]) {
      const result = verify(entries);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /compile command|compile arguments|disable Eigen vectorization/);
    }
    for (const flags of [[], ["-ffp-contract=fast"], ["-ffp-contract=on"],
      ["-ffp-contract=off", "-ffp-contract=fast"], ["-ffp-contract=fast", "-ffp-contract=off"],
      ["-ffp-contract=off", "-ffp-contract=off"],
      ...["-Ofast", "-ffast-math", "-funsafe-math-optimizations", "-fassociative-math", "-ffp-model=fast", "@flags"].map((flag) => ["-ffp-contract=off", flag]),
    ]) {
      const arguments_ = entry.arguments.filter((arg) => arg !== "-ffp-contract=off").concat(flags);
      const result = verify([{ ...entry, arguments: arguments_ }]);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /disable floating-point contraction/);
    }
    passed = true;
  } finally {
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Retained nextpnr numeric metadata evidence: ${directory}`);
  }
});

test("the nextpnr source preparer preserves upstream, is idempotent, and rejects bad patches and metadata", () => {
  const directory = mkdtempSync(path.join(root, "build/t5-pnr-prepare-check-"));
  let passed = false;
  try {
    const original = readFileSync(upstream);
    const source = path.join(directory, "original.cc");
    const output = path.join(directory, "patched/placer_heap.cc");
    const metadataPath = path.join(directory, "patched/placer_heap.json");
    writeFileSync(source, original);
    const prepare = (patch, destination = output, origin = source) => spawnSync("python3", [
      path.join(root, "scripts/prepare-pnr-source.py"), "--source", origin, "--patch", patch, "--output", destination,
    ], { encoding: "utf8" });
    const prepared = prepare(patchFile);
    assert.equal(prepared.status, 0, prepared.stderr);
    const patched = readFileSync(output);
    assert.equal(patched.toString(), original.toString().replace(
      "std::sort(cut_cells.begin(), cut_cells.end()", "std::stable_sort(cut_cells.begin(), cut_cells.end()",
    ));
    assert.deepEqual(readFileSync(upstream), original);
    assert.deepEqual(readFileSync(source), original);
    const metadata = JSON.parse(readFileSync(metadataPath));
    assert.deepEqual(metadata, {
      translation_unit: "common/place/placer_heap.cc",
      source_sha256: sha256(original), patch: path.basename(patchFile),
      patch_sha256: sha256(readFileSync(patchFile)), patched_source_sha256: sha256(patched),
    });
    for (const file of [output, metadataPath]) utimesSync(file, 1000, 1000);
    assert.equal(prepare(patchFile).status, 0);
    for (const file of [output, metadataPath]) assert.equal(statSync(file).mtimeMs, 1000000);
    assert.equal(prepare(patchFile, source).status, 1);
    assert.deepEqual(readFileSync(source), original);
    assert.equal(prepare(patchFile, path.join(directory, "collision.json")).status, 1);
    const alias = path.join(directory, "alias.json");
    writeFileSync(alias, original);
    assert.equal(prepare(patchFile, path.join(directory, "alias.cc"), alias).status, 1);
    assert.deepEqual(readFileSync(alias), original);
    const patchCopy = path.join(directory, "valid.patch");
    writeFileSync(patchCopy, readFileSync(patchFile));
    assert.equal(prepare(patchCopy, patchCopy).status, 1);
    assert.deepEqual(readFileSync(patchCopy), readFileSync(patchFile));
    const invalidPatch = path.join(directory, "invalid.patch");
    writeFileSync(invalidPatch, readFileSync(patchFile, "utf8").replace("-            std::sort", "-            std::absent_sort"));
    assert.equal(prepare(invalidPatch).status, 1);
    assert.deepEqual(readFileSync(output), patched);
    const globalSource = path.join(root, "vendor/nextpnr/himbaechel/uarch/gowin/globals.cc");
    const globalOriginal = readFileSync(globalSource);
    const globalOutput = path.join(directory, "patched/globals.cc");
    const globalPatch = path.join(root, "patches/nextpnr/0004-stabilize-segment-grid-order.patch");
    const globalPrepared = spawnSync("python3", [
      path.join(root, "scripts/prepare-pnr-source.py"), "--source", globalSource, "--patch", globalPatch,
      "--output", globalOutput, "--translation-unit", "himbaechel/uarch/gowin/globals.cc",
    ], { encoding: "utf8" });
    assert.equal(globalPrepared.status, 0, globalPrepared.stderr);
    assert.equal(readFileSync(globalOutput, "utf8"), globalOriginal.toString().replace(
      "std::unordered_multimap<uint32_t, grid_net> grid;", "std::multimap<uint32_t, grid_net> grid;",
    ));
    assert.deepEqual(readFileSync(globalSource), globalOriginal);
    const verify = () => spawnSync("python3", ["-c", `
import importlib.util
from pathlib import Path
spec = importlib.util.spec_from_file_location("pnr_info", ${JSON.stringify(path.join(root, "scripts/build-pnr-info.py"))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.patch_metadata(Path(${JSON.stringify(directory)}))
`], { encoding: "utf8" });
    assert.equal(verify().status, 0);
    const rejected = (pattern) => {
      const result = verify();
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, pattern);
    };
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, source_sha256: "0".repeat(64) }));
    rejected(/patch metadata does not match/);
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, patch: "../outside.patch" }));
    rejected(/Invalid nextpnr patch path/);
    writeFileSync(metadataPath, JSON.stringify(metadata));
    const globalMetadataPath = path.join(directory, "patched/globals.json");
    const globalMetadata = JSON.parse(readFileSync(globalMetadataPath));
    writeFileSync(globalMetadataPath, JSON.stringify({ ...globalMetadata, translation_unit: "common/route/router1.cc" }));
    rejected(/patch metadata does not match/);
    writeFileSync(globalMetadataPath, JSON.stringify(globalMetadata));
    writeFileSync(globalOutput, Buffer.concat([readFileSync(globalOutput), Buffer.from("// corruption\n")]));
    rejected(/patch metadata does not match/);
    writeFileSync(globalOutput, globalOriginal.toString().replace(
      "std::unordered_multimap<uint32_t, grid_net> grid;", "std::multimap<uint32_t, grid_net> grid;",
    ));
    writeFileSync(output, Buffer.concat([patched, Buffer.from("// corruption\n")]));
    rejected(/patch metadata does not match/);
    passed = true;
  } finally {
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Source preparation evidence retained: ${directory}`);
  }
});

function checker(source) {
  const bodies = [...source.matchAll(/std::stable_sort\(result.begin\(\), result.end\(\), \[&\]\(Loc a, Loc b\) \{([\s\S]*?)\n        \}\);/g)];
  assert.equal(bodies.length, 1, "Expected one control-set candidate comparator");
  return `#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <vector>
struct Loc { int x, y, z; };
int main() {
  for (int cx = -2; cx <= 2; ++cx) for (int cy = -2; cy <= 2; ++cy) {
    auto compare = [&](Loc a, Loc b) {${bodies[0][1]}
    };
    std::vector<Loc> original;
    for (int x = -2; x <= 2; ++x) for (int y = -2; y <= 2; ++y)
      original.push_back({x, y, int(original.size())});
    for (auto a : original) {
      if (compare(a, a)) { std::fprintf(stderr, "CONTROL_SET_NOT_IRREFLEXIVE\\n"); return 1; }
      for (auto b : original) {
        if (compare(a, b) && compare(b, a)) { std::fprintf(stderr, "CONTROL_SET_NOT_ASYMMETRIC\\n"); return 1; }
        for (auto c : original) {
          if (compare(a, b) && compare(b, c) && !compare(a, c)) {
            std::fprintf(stderr, "CONTROL_SET_NOT_TRANSITIVE\\n"); return 1;
          }
        }
      }
    }
    std::vector<Loc> expected;
    for (int distance = 0; distance <= 8; ++distance) for (auto a : original) {
      int dx = a.x < cx ? cx - a.x : a.x - cx;
      int dy = a.y < cy ? cy - a.y : a.y - cy;
      if (dx + dy == distance) expected.push_back(a);
    }
    auto actual = original;
    std::stable_sort(actual.begin(), actual.end(), compare);
    if (actual.size() != expected.size()) return 2;
    for (unsigned i = 0; i < actual.size(); ++i) {
      if (actual[i].z != expected[i].z) { std::fprintf(stderr, "CONTROL_SET_WRONG_ORDER\\n"); return 1; }
    }
  }
  std::puts("CONTROL_SET_ORDER_OK centers=25 locations=25 triples=390625");
}
`;
}

function assertPatchedOrdering(patchName, makeChecker, failure, success) {
  const directory = mkdtempSync(path.join(root, "build/t5-control-set-check-"));
  let passed = false;
  try {
    mkdirSync(path.join(directory, "common/place"), { recursive: true });
    const original = readFileSync(upstream, "utf8");
    writeFileSync(path.join(directory, "common/place/placer_heap.cc"), original);
    const patch = path.join(root, "patches/nextpnr", patchName);
    const applied = spawnSync("patch", ["--batch", "--fuzz=0", "-p1", "-i", patch], {
      cwd: directory, encoding: "utf8",
    });
    assert.equal(applied.status, 0, `${applied.stderr}\n${applied.stdout}\n${applied.error ?? ""}`);
    const patched = readFileSync(path.join(directory, "common/place/placer_heap.cc"), "utf8");
    for (const [variant, source] of [["original", original], ["patched", patched]]) {
      const input = path.join(directory, `${variant}.cc`);
      const executable = path.join(directory, variant);
      writeFileSync(input, source.slice(0, source.indexOf("#include")) + makeChecker(source));
      const compiled = spawnSync(process.env.CXX ?? "c++", ["-std=c++17", "-O2", "-Wall", "-Wextra", "-Werror", input, "-o", executable], {
        encoding: "utf8",
      });
      assert.equal(compiled.status, 0, `${compiled.stderr}\n${compiled.error ?? ""}`);
      const result = spawnSync(executable, [], { encoding: "utf8" });
      assert.equal(result.error, undefined);
      assert.equal(result.status, variant === "original" ? 1 : 0, result.stderr);
      if (variant === "original") assert.match(result.stderr, failure);
      else assert.equal(result.stdout, success);
    }
    passed = true;
  } finally {
    if (passed) rmSync(directory, { recursive: true, force: true });
    else console.error(`Control-set evidence retained: ${directory}`);
  }
}

test("the nextpnr control-set patch restores strict weak ordering and stable Manhattan order", () => {
  assertPatchedOrdering("0001-fix-control-set-distance-comparison.patch", checker,
    /CONTROL_SET_NOT_IRREFLEXIVE/, "CONTROL_SET_ORDER_OK centers=25 locations=25 triples=390625\n");
});

function cutChecker(source) {
  const calls = [...source.matchAll(/std::(?:stable_)?sort\(cut_cells.begin\(\), cut_cells.end\(\), \[&\]\(const CellInfo \*a, const CellInfo \*b\) \{[\s\S]*?\n            \}\);/g)];
  assert.equal(calls.length, 1, "Expected one cut-region coordinate sort");
  return `#include <algorithm>
#include <cstdio>
#include <vector>
struct CellInfo { int name; };
struct Position { double rawx, rawy; };
struct Placer { std::vector<Position> cell_locs; };
int main() {
  Placer placer;
  auto p = &placer;
  std::vector<CellInfo> cells(33);
  for (int axis = 0; axis < 2; ++axis) for (int mixed = 0; mixed < 2; ++mixed) {
    bool dir = axis != 0;
    std::vector<CellInfo *> cut_cells;
    p->cell_locs.clear();
    for (int i = 0; i < 33; ++i) {
      cells[i].name = i;
      cut_cells.push_back(&cells[i]);
      p->cell_locs.push_back({double(mixed ? (i * 17) % 5 : 0), double(mixed ? (i * 13) % 7 : 0)});
    }
    std::vector<int> expected;
    for (int key = 0; key < 7; ++key) for (int i = 0; i < 33; ++i) {
      auto loc = p->cell_locs.at(i);
      if ((dir ? loc.rawy : loc.rawx) == key) expected.push_back(i);
    }
    ${calls[0][0]}
    if (expected.size() != cut_cells.size()) return 2;
    for (unsigned i = 0; i < expected.size(); ++i) {
      if (cut_cells[i]->name != expected[i]) { std::fprintf(stderr, "CUT_TIE_ORDER_CHANGED\\n"); return 1; }
    }
  }
  std::puts("CUT_TIE_ORDER_OK axes=2 patterns=2 cells=33");
}
`;
}

test("the nextpnr cut patch preserves equal-coordinate input order on both axes", () => {
  assertPatchedOrdering("0002-stabilize-equal-coordinate-cuts.patch", cutChecker,
    /CUT_TIE_ORDER_CHANGED/, "CUT_TIE_ORDER_OK axes=2 patterns=2 cells=33\n");
});
