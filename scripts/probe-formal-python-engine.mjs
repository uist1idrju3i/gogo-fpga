import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { nodeFormalWorker, readFormalSources } from "../tests/synth/formal-python-helpers.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";
import { loadSolverProbe, verifyNativeSolver } from "../tests/synth/solver-protocol-helpers.mjs";
import { sbyCases, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";
import { startSolverProcess } from "../web/lib/solver-process.mjs";

globalThis.crossOriginIsolated = true;
const root = path.resolve(import.meta.dirname, "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const normalizeLog = text => text.replace(/^##\s+\d+:\d\d:\d\d\s+/gm, "## TIME ");
const { values } = parseArgs({ options: {
  sources: { type: "string" }, probes: { type: "string" }, baseline: { type: "string" },
  out: { type: "string" }, solver: { type: "string" }, case: { type: "string" },
  formal: { type: "boolean", default: false },
} });
assert.ok(values.sources && values.probes && values.baseline && values.out,
  "Use --sources ASSETS --probes MANIFEST --baseline NATIVE_SBY --out NEW_DIRECTORY");
assert.ok(!existsSync(values.out), "Refuse to overwrite probe output");
const out = path.resolve(values.out);
mkdirSync(out);
const sources = readFormalSources(values.sources);
const probes = JSON.parse(readFileSync(values.probes));
const reference = JSON.parse(readFileSync(path.join(values.baseline, "results.json")));
const nativeMetadata = readFileSync(path.join(values.baseline, "metadata.json"));
assert.equal(reference.preliminary, !values.formal, "Matching native result mode required");
assert.equal(JSON.parse(nativeMetadata).preliminary, !values.formal, "Matching native metadata mode required");
writeFileSync(path.join(out, "native-metadata.json"), nativeMetadata);
const python = process.env.PYTHON ?? "python3";
const binaryDir = path.join(out, "bin"); mkdirSync(binaryDir);
const metadata = {
  format: 1, preliminary: !values.formal, baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktreeStatus: execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }),
  node: process.version, python: execFileSync(python, ["--version"], { encoding: "utf8" }).trim(),
  pyodide: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  scriptSha256: digest(readFileSync(import.meta.filename)), nativeMetadataSha256: digest(nativeMetadata),
  sources: sources.manifest, snapshots: {}, probes: {}, models: {}, solverCommands: {},
};
const snapshotNames = [".gitmodules", "package-lock.json", "scripts/probe-formal-python-engine.mjs", "scripts/build-formal-python.py",
  "scripts/audit-formal-python.py", "patches/yosys-smtio-process.patch", "web/formal_process.py",
  "web/lib/formal-python-process.mjs", "web/lib/formal-python-job.mjs", "web/lib/formal-process-client.mjs",
  "web/lib/solver-process.mjs", "web/lib/solver-job.mjs", "web/lib/byte-pipe.mjs", "web/lib/wasi-p1.mjs",
  "tests/web/formal-python-node-worker.mjs", "tests/web/solver-node-worker.mjs", "tests/web/solver-process-helpers.mjs",
  "tests/synth/formal-python-helpers.mjs", "tests/synth/formal-sby-cases.mjs", "tests/synth/solver-protocol-helpers.mjs",
  "scripts/formal-solver-audit.py", "scripts/probe-upstream-formal.mjs"];
if (values.formal) snapshotNames.push("scripts/measure-extra-formal.py");
for (const name of snapshotNames) {
  const bytes = readFileSync(path.join(root, name));
  const target = path.join(out, "snapshots", name); mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes); metadata.snapshots[name] = digest(bytes);
}
for (const file of sources.sources) {
  const target = path.join(out, "assets", file.path); mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, file.bytes);
}
writeFileSync(path.join(out, "assets/manifest.json"), JSON.stringify(sources.manifest, null, 2) + "\n");
writeFileSync(path.join(out, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
const rows = [];
for (const solver of selectFormalSolvers(values.solver)) {
  const nativeProbe = loadSolverProbe(probes[solver].native, solver, "native");
  const wasiProbe = loadSolverProbe(probes[solver].wasi, solver, "wasi");
  const executable = solver === "yices2" ? "yices-smt2" : solver;
  symlinkSync(nativeProbe.binaryPath, path.join(binaryDir, executable));
  metadata.solverCommands[solver] = verifyNativeSolver(executable, binaryDir, nativeProbe.info.artifact.sha256,
    { ...process.env, PATH: `${binaryDir}${path.delimiter}${process.env.PATH}` });
  mkdirSync(path.join(out, "inputs"), { recursive: true });
  writeFileSync(path.join(out, "inputs", `${solver}-native`), nativeProbe.binary);
  writeFileSync(path.join(out, "inputs", `${solver}.wasm`), wasiProbe.binary);
  for (const [runtime, probe] of [["native", nativeProbe], ["wasi", wasiProbe]]) {
    writeFileSync(path.join(out, `${solver}-${runtime}-build.json`), probe.metadata);
    let version;
    if (runtime === "native") {
      version = execFileSync(probe.binaryPath, ["--version"], { encoding: "utf8", timeout: 10000 });
    } else {
      const stdout = []; const stderr = [];
      const versionProcess = startSolverProcess({ wasm: probe.binary, sha256: probe.info.artifact.sha256,
        args: [executable, "--version"], timeoutMs: 10000, workerFactory: () => nodeSolverWorker(),
        onStdout: data => stdout.push(Buffer.from(data)), onStderr: data => stderr.push(Buffer.from(data)) });
      versionProcess.endInput();
      const result = await versionProcess.completion;
      assert.equal(result.status, "exited"); assert.equal(result.exitCode, 0); assert.equal(result.integrityVerified, true);
      assert.equal(Buffer.concat(stderr).length, 0);
      version = Buffer.concat(stdout).toString("utf8");
    }
    assert.ok(version.trim());
    writeFileSync(path.join(out, `${solver}-${runtime}-version.log`), version);
    metadata.probes[`${solver}-${runtime}`] = { metadataSha256: probe.metadataSha256, binarySha256: digest(probe.binary), version };
  }
  for (const fixture of sbyCases.filter(item => !values.case || item.name === values.case)) {
    const recorded = reference.rows.find(row => row.solver === solver && row.case === fixture.name);
    assert.ok(recorded && !recorded.error, "Missing native SBY reference");
    const baselineFile = path.join(values.baseline, `${solver}-${fixture.name}`, "result/model/design_smt2.smt2");
    const model = readFileSync(baselineFile);
    assert.equal(digest(model), recorded.files["result/model/design_smt2.smt2"].sha256);
    metadata.models[`${solver}-${fixture.name}`] = digest(model);
    const phases = fixture.mode === "prove" ? ["basecase", "induction"] : [fixture.mode];
    for (const phase of phases) {
      const label = `${solver}-${fixture.name}-${phase}`;
      const working = path.join(out, label); mkdirSync(working);
      const nativeDirectory = path.join(working, "native"); mkdirSync(nativeDirectory);
      const files = [{ path: "model.smt2", bytes: new Uint8Array(model) },
        { path: "top.v", bytes: new TextEncoder().encode(fixture.source) }];
      for (const file of files) writeFileSync(path.join(nativeDirectory, file.path), file.bytes);
      const args = ["-s", solver === "yices2" ? "yices" : solver, "--presat", "--noprogress",
        ...(solver === "yices2" ? ["--unroll"] : []),
        ...(phase === "cover" ? ["-c"] : phase === "induction" ? ["-i"] : []),
        "-t", String(fixture.depth), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"];
      const started = performance.now();
      const native = spawnSync(python, [path.join(root, "vendor/yosys/backends/smt2/smtbmc.py"), ...args], {
        cwd: nativeDirectory, env: { ...process.env, PATH: `${binaryDir}:${process.env.PATH}` },
        encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
      });
      const nativeElapsedMs = performance.now() - started;
      writeFileSync(path.join(working, "native.stdout.log"), native.stdout ?? "");
      writeFileSync(path.join(working, "native.stderr.log"), native.stderr ?? "");
      writeFileSync(path.join(working, "native.json"), JSON.stringify({ args, elapsedMs: nativeElapsedMs,
        exitCode: native.status, signal: native.signal, error: native.error?.message ?? null }, null, 2) + "\n");
      const stdout = []; const stderr = [];
      const engine = startFormalPython({ ...sources, entrypoint: "smtbmc", args, files,
        solvers: { [executable]: { wasm: wasiProbe.binary, sha256: wasiProbe.info.artifact.sha256,
          exitCodes: solver === "boolector" ? [0, 10, 20] : [0] } },
        workerFactory: nodeFormalWorker, solverWorkerFactory: () => nodeSolverWorker(),
        onStdout: line => stdout.push(line), onStderr: line => stderr.push(line), timeoutMs: 30_000,
      });
      const result = await engine.completion;
      writeFileSync(path.join(working, "pyodide.stdout.log"), stdout.join(""));
      writeFileSync(path.join(working, "pyodide.stderr.log"), stderr.join(""));
      const returnedFiles = result.files ?? [];
      const row = { solver, case: fixture.name, phase, nativeElapsedMs, pyodideElapsedMs: result.elapsedMs,
        nativeExitCode: native.status, pyodideExitCode: result.exitCode, status: result.status,
        modelSha256: digest(model), solverSha256: wasiProbe.info.artifact.sha256, children: result.children,
        nativeStdoutSha256: digest(native.stdout ?? ""), pyodideStdoutSha256: digest(stdout.join("")), files: [] };
      for (const file of returnedFiles) {
        const target = path.join(working, `pyodide-${file.path}`); mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
        row.files.push({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes) });
      }
      try {
        assert.ifError(native.error);
        const expected = ["bmc-violation", "cover-unreached"].includes(fixture.name) ||
          (fixture.name === "prove-inconclusive" && phase === "induction") ? 1 : 0;
        assert.equal(native.status, expected);
        assert.equal(result.status, "exited", result.error);
        assert.equal(result.exitCode, expected, stderr.join(""));
        assert.match(stdout.join(""), new RegExp(`Status: ${expected ? "FAILED" : "PASSED"}\\n$`));
        assert.equal(stderr.join(""), native.stderr);
        assert.equal(normalizeLog(stdout.join("")), normalizeLog(native.stdout));
        assert.equal(result.children.length, solver === "bitwuzla" ? 2 : 1);
        assert.ok(result.children.every(child => child.status === "exited" &&
          (solver === "boolector" ? [0, 10, 20] : [0]).includes(child.exitCode) && child.integrityVerified));
        const nativeNames = readdirSync(nativeDirectory).sort();
        const traceRequired = fixture.name === "bmc-violation" || fixture.name === "cover-reached" ||
          (fixture.name === "prove-inconclusive" && phase === "induction");
        assert.deepEqual(nativeNames, (traceRequired ? ["model.smt2", "top.v", "trace.vcd", "trace.yw", "trace_tb.v"] : ["model.smt2", "top.v"]));
        assert.deepEqual(returnedFiles.map(f => f.path).sort(), nativeNames);
        for (const file of returnedFiles) {
          const bytes = readFileSync(path.join(nativeDirectory, file.path));
          assert.deepEqual(Buffer.from(file.bytes), bytes, `Artifact differs: ${file.path}`);
        }
      } catch (error) { row.error = error.message; }
      const { files: ignored, ...transport } = result;
      writeFileSync(path.join(working, "transport.json"), JSON.stringify(transport, null, 2) + "\n");
      writeFileSync(path.join(working, "result.json"), JSON.stringify(row, null, 2) + "\n");
      rows.push(row);
      console.log(`${label}: ${row.error ?? "matched"}`);
    }
  }
}
assert.ok(rows.length > 0, "No formal engine conditions selected");
writeFileSync(path.join(out, "metadata-final.json"), JSON.stringify(metadata, null, 2) + "\n");
writeFileSync(path.join(out, "results.json"), JSON.stringify({ preliminary: !values.formal, rows }, null, 2) + "\n");
const columns = ["solver", "case", "phase", "nativeElapsedMs", "pyodideElapsedMs", "nativeExitCode", "pyodideExitCode",
  "status", "modelSha256", "solverSha256", "nativeStdoutSha256", "pyodideStdoutSha256", "error"];
const cell = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
writeFileSync(path.join(out, "results.csv"), [columns, ...rows.map(row => columns.map(name => row[name]))]
  .map(row => row.map(cell).join(",")).join("\n") + "\n");
if (rows.some(row => row.error)) process.exitCode = 1;
