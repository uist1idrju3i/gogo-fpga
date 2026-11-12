import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { nodeFormalWorker, nodeFormalWasiWorker, readFormalSources } from "../tests/synth/formal-python-helpers.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";
import { loadSolverProbe, digest, root } from "../tests/synth/solver-protocol-helpers.mjs";
import { sbyCases, sbyConfig, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";
import { readSbyStatus, classifySbyStatus } from "./probe-upstream-formal.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: { ...Object.fromEntries(["sources", "probes", "synth", "baseline", "out", "solver", "case"].map(name => [name, { type: "string" }])), formal: { type: "boolean", default: false } } });
assert.ok(values.sources && values.probes && values.synth && values.baseline && values.out,
  "Use --sources ASSETS --probes MANIFEST --synth YOSYS_ASSETS --baseline NATIVE_SBY --out NEW_DIRECTORY");
assert.ok(!existsSync(values.out), "Refuse to overwrite evidence");
const out = path.resolve(values.out); mkdirSync(out);
const save = (name, bytes) => { const target = path.join(out, name); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes); };
const json = (name, data) => save(name, JSON.stringify(data, null, 2) + "\n");
const sources = readFormalSources(values.sources);
const probes = JSON.parse(readFileSync(values.probes));
const manifest = JSON.parse(readFileSync(path.join(values.synth, "manifest.json")));
const asset = name => manifest.assets.find(item => item.path === name);
const yosys = { wasm: new Uint8Array(readFileSync(path.join(values.synth, "yosys.wasm"))), sha256: asset("yosys.wasm").sha256,
  share: new Uint8Array(readFileSync(path.join(values.synth, "yosys-share.tar"))), shareSha256: asset("yosys-share.tar").sha256 };
assert.equal(digest(yosys.wasm), yosys.sha256); assert.equal(digest(yosys.share), yosys.shareSha256);
const baseline = JSON.parse(readFileSync(path.join(values.baseline, "results.json")));
const nativeMetadata = JSON.parse(readFileSync(path.join(values.baseline, "metadata.json")));
json("native-metadata.json", nativeMetadata);
assert.equal(nativeMetadata.preliminary, !values.formal, "Matching native measurement mode required");
assert.equal(baseline.preliminary, !values.formal, "Matching native result mode required");
const metadata = { format: 1, preliminary: !values.formal, command: process.argv.slice(1), node: process.version,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
  pyodidePackage: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  nativeMetadataSha256: digest(readFileSync(path.join(out, "native-metadata.json"))),
  sources: sources.manifest, yosys: { sha256: yosys.sha256, shareSha256: yosys.shareSha256 }, snapshots: {}, probes: {} };
const snapshots = ["scripts/probe-formal-sby.mjs", "scripts/read-sby-status-db.py", "scripts/probe-upstream-formal.mjs",
  "scripts/audit-formal-sby.py", "scripts/sby-artifact-audit.py", "scripts/formal-solver-audit.py",
  "scripts/build-formal-python.py", "package-lock.json", ".gitmodules", "patches/sby-process.patch", "patches/yosys-smtio-process.patch",
  "web/formal_process.py", "web/formal-python-worker.mjs", "web/formal-wasi-worker.mjs",
  ...["formal-python-process", "formal-python-job", "formal-process-client", "formal-tool-process", "formal-tool-client",
    "formal-tool-command", "formal-wasi-job", "formal-workspace", "byte-pipe", "solver-process", "solver-job", "wasi-p1",
    "verified-assets"].map(name => `web/lib/${name}.mjs`), "tests/synth/formal-sby-cases.mjs", "tests/synth/formal-python-helpers.mjs",
  "tests/synth/solver-protocol-helpers.mjs", "tests/web/formal-python-node-worker.mjs", "tests/web/formal-wasi-node-worker.mjs",
  "tests/web/solver-node-worker.mjs", "tests/web/solver-process-helpers.mjs"];
if (values.formal) snapshots.push("scripts/measure-formal-sby.py", "scripts/measure-extra-formal.py");
for (const name of snapshots) { const bytes = readFileSync(path.join(root, name)); save(`snapshots/${name}`, bytes); metadata.snapshots[name] = digest(bytes); }
for (const file of sources.sources) save(`assets/${file.path}`, file.bytes);
save("inputs/yosys.wasm", yosys.wasm); save("inputs/yosys-share.tar", yosys.share);
const nativeYosys = readFileSync(nativeMetadata.nativeCommands.yosys);
assert.equal(digest(nativeYosys), nativeMetadata.yosys.sha256);
save("inputs/yosys-native", nativeYosys);
json("assets/manifest.json", sources.manifest); json("metadata.json", metadata);
const encoder = new TextEncoder();
const rows = [];
for (const solver of selectFormalSolvers(values.solver)) {
  const probe = loadSolverProbe(probes[solver].wasi, solver, "wasi");
  const nativeBuild = readFileSync(path.join(values.baseline, `${solver}-bin/metadata.json`));
  const nativeInfo = JSON.parse(nativeBuild);
  assert.equal(nativeMetadata.solverCommands?.[solver]?.sha256, nativeInfo.artifact.sha256, "Missing verified native solver command");
  const nativeBinary = readFileSync(path.join(values.baseline, `${solver}-bin`, solver === "yices2" ? "yices-smt2" : solver));
  assert.equal(digest(nativeBinary), nativeInfo.artifact.sha256);
  metadata.probes[solver] = { metadataSha256: probe.metadataSha256, sha256: probe.info.artifact.sha256,
    nativeMetadataSha256: digest(nativeBuild), nativeSha256: nativeInfo.artifact.sha256 };
  save(`build/${solver}-native.json`, nativeBuild);
  save(`inputs/${solver}-native`, nativeBinary); save(`inputs/${solver}.wasm`, probe.binary);
  json(`build/${solver}.json`, probe.info);
  for (const fixture of sbyCases.filter(item => !values.case || item.name === values.case)) {
    const label = `${solver}-${fixture.name}`;
    const reference = baseline.rows.find(row => row.solver === solver && row.case === fixture.name);
    assert.ok(reference && !reference.error && reference.status === fixture.status, "Missing native baseline");
    for (const [name, info] of Object.entries(reference.files)) {
      const bytes = readFileSync(path.join(values.baseline, label, name));
      assert.equal(bytes.length, info.bytes); assert.equal(digest(bytes), info.sha256);
      save(`${label}/native/${name}`, bytes);
    }
    json(`${label}/native.json`, reference);
    const stdout = []; const stderr = [];
    const result = await startFormalPython({ ...sources, entrypoint: "sby",
      args: ["-j", "1", "-d", "result", "--yosys", "yosys", "--smtbmc", "yosys-smtbmc", "--witness", "yosys-witness", "job.sby"],
      files: [{ path: "job.sby", bytes: encoder.encode(sbyConfig(fixture, solver)) }, { path: "top.v", bytes: encoder.encode(fixture.source) }],
      solvers: { [solver === "yices2" ? "yices-smt2" : solver]: { wasm: probe.binary, sha256: probe.info.artifact.sha256,
        exitCodes: solver === "boolector" ? [0, 10, 20] : [0] } }, yosys,
      timeoutMs: 60_000, workerFactory: nodeFormalWorker, solverWorkerFactory: nodeSolverWorker, wasiWorkerFactory: nodeFormalWasiWorker,
      onStdout: line => stdout.push(line), onStderr: line => stderr.push(line) }).completion;
    save(`${label}/stdout.log`, stdout.join("")); save(`${label}/stderr.log`, stderr.join(""));
    const { files = [], ...transport } = result; json(`${label}/transport.json`, transport);
    for (const file of files) save(`${label}/pyodide/${file.path}`, file.bytes);
    const row = { solver, case: fixture.name, mode: fixture.mode, depth: fixture.depth, expected: fixture.status,
      status: null, kind: null, exitCode: result.exitCode ?? null, elapsedMs: result.elapsedMs, artifactCount: files.length,
      comparedCount: 0, sqliteSha256: null, modelSha256: null, solverSha256: probe.info.artifact.sha256, yosysSha256: yosys.sha256, error: null };
    try {
      assert.equal(result.status, "exited", result.error); assert.equal(result.integrityVerified, true);
      assert.equal(stderr.join(""), "");
      const text = name => readFileSync(path.join(out, label, "pyodide", name), "utf8");
      row.status = readSbyStatus(text("result/status"), result.exitCode, stdout.join(""));
      assert.equal(row.status, fixture.status);
      assert.match(stdout.join("").trimEnd().split("\n").at(-1), new RegExp(` DONE \\(${row.status}, rc=${row.exitCode}\\)$`));
      row.kind = classifySbyStatus(fixture.mode, row.status); assert.equal(row.kind, fixture.kind);
      assert.ok(result.children.length >= 4 && result.children.every(child => child.status === "exited" && child.integrityVerified && Number.isInteger(child.exitCode)));
      assert.deepEqual(files.map(file => file.path).sort(), Object.keys(reference.files).filter(name => !["stdout.log", "stderr.log"].includes(name)).sort());
      for (const file of files) {
        if (!/\.(?:v|sby|ys|il|smt2|vcd|yw|smtc)$/.test(file.path) && !/^result\/engine_0\/logfile.*\.txt$/.test(file.path)) continue;
        const original = readFileSync(path.join(out, label, "native", file.path), "utf8");
        const actual = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        const normalize = value => value.replace(/^(# Generated by |; SMT-LIBv2 description generated by )(Yosys [^\n]+), Release, [^\n]+\n/, "$1$2)\n")
          .replace(/^##\s+\d+:\d\d:\d\d\s+/gm, "## TIME ");
        assert.equal(normalize(actual), normalize(original), `Artifact mismatch: ${file.path}`); row.comparedCount++;
      }
      const readDb = runtime => JSON.parse(execFileSync(process.env.PYTHON ?? "python3", [path.join(root, "scripts/read-sby-status-db.py"),
        path.join(out, label, runtime, "result/status.sqlite")], { encoding: "utf8" }));
      const nativeDb = readDb("native"); const pyodideDb = readDb("pyodide");
      json(`${label}/native-status.json`, nativeDb); json(`${label}/pyodide-status.json`, pyodideDb);
      assert.deepEqual(pyodideDb, nativeDb, "SQLite status rows differ");
      row.sqliteSha256 = digest(readFileSync(path.join(out, label, "pyodide/result/status.sqlite")));
      row.modelSha256 = digest(readFileSync(path.join(out, label, "pyodide/result/model/design_smt2.smt2")));
    } catch (error) { row.error = error.message; }
    json(`${label}/result.json`, row); rows.push(row); json("results.json", { preliminary: !values.formal, rows });
    console.log(`${label}: ${row.error ?? `${row.status} (${row.kind}), ${row.comparedCount} artifacts + SQLite matched`}`);
  }
}
assert.ok(rows.length, "No conditions selected");
json("metadata-final.json", metadata);
const columns = Object.keys(rows[0]);
const cell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
save("results.csv", [columns, ...rows.map(row => columns.map(name => row[name]))].map(row => row.map(cell).join(",")).join("\n") + "\n");
if (rows.some(row => row.error)) process.exitCode = 1;
