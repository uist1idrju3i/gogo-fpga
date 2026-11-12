import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startFormalPython } from "../web/lib/formal-python-process.mjs";
import { nodeFormalWorker, readFormalSources } from "../tests/synth/formal-python-helpers.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";
import { digest, loadSolverProbe, root, verifyNativeSolver } from "../tests/synth/solver-protocol-helpers.mjs";
import { sbyCases, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: {
  sources: { type: "string" }, probes: { type: "string" }, baseline: { type: "string" },
  out: { type: "string" }, solver: { type: "string" }, case: { type: "string" }, formal: { type: "boolean", default: false },
} });
assert.ok(values.sources && values.probes && values.baseline && values.out,
  "Use --sources ASSETS --probes MANIFEST --baseline NATIVE_SBY --out NEW_DIRECTORY");
const solvers = selectFormalSolvers(values.solver);
assert.ok(!values.formal || !values.case, "Formal evidence requires every fixture");
const worktree = execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" });
assert.ok(!values.formal || worktree === "", "Formal evidence requires a clean worktree");
const fixtures = sbyCases.filter(fixture => !values.case || fixture.name === values.case);
assert.ok(fixtures.length, "Unknown trace fixture");
const out = path.resolve(values.out);
assert.ok(!existsSync(out), "Refuse to overwrite trace evidence");
mkdirSync(out);
const assets = readFormalSources(values.sources);
const probes = JSON.parse(readFileSync(values.probes));
const reference = JSON.parse(readFileSync(path.join(values.baseline, "results.json")));
const baselineBytes = readFileSync(path.join(values.baseline, "metadata.json"));
const baseline = JSON.parse(baselineBytes);
assert.equal(baseline.yosys.sha256, digest(readFileSync(path.join(root, "build/native/yosys"))));
for (const [name, sha256] of Object.entries(baseline.sources)) {
  assert.equal(digest(readFileSync(path.join(root, name))), sha256, `Baseline source differs: ${name}`);
}
const python = process.env.PYTHON ?? "python3";
const metadata = {
  format: 1, preliminary: !values.formal, artifactOrder: "codepoint", argv: process.argv,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), worktree,
  submodules: execFileSync("git", ["submodule", "status"], { cwd: root, encoding: "utf8" }),
  host: { platform: os.platform(), release: os.release(), architecture: os.arch(), cpus: os.cpus().length,
    cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem() },
  node: process.version, python: execFileSync(python, ["--version"], { encoding: "utf8" }).trim(),
  pyodide: JSON.parse(readFileSync(path.join(root, "node_modules/pyodide/package.json"))).version,
  baselineSha256: digest(baselineBytes), baselineResultsSha256: digest(readFileSync(path.join(values.baseline, "results.json"))),
  sources: assets.manifest, probes: {}, snapshots: {},
  sourcePins: Object.fromEntries(solvers.map(solver => [solver,
    execFileSync("git", ["ls-tree", "HEAD", `vendor/${solver}`], { cwd: root, encoding: "utf8" }).match(/^160000 commit ([a-f0-9]{40})\t/)?.[1]])),
};
if (values.formal) assert.ok(baseline.preliminary === false && baseline.worktree === "" && baseline.commit === metadata.commit,
  "Formal native baseline must use the same clean commit");
writeFileSync(path.join(out, "baseline-metadata.json"), baselineBytes);
writeFileSync(path.join(out, "baseline-results.json"), readFileSync(path.join(values.baseline, "results.json")));
for (const name of new Set(["scripts/probe-formal-trace.mjs", "scripts/build-formal-python.py", "web/formal_trace.py",
  ...readdirSync(path.join(root, "web/lib")).filter(name => name.startsWith("formal-")).map(name => `web/lib/${name}`),
  "tests/synth/formal-python-helpers.mjs", "tests/synth/formal-sby-cases.mjs", "tests/synth/solver-protocol-helpers.mjs",
  "tests/web/solver-process-helpers.mjs", "tests/web/formal-python-node-worker.mjs", "tests/web/solver-node-worker.mjs",
  ...Object.keys(baseline.sources), ...Object.keys(assets.manifest.patches).map(name => "patches/" + name),
  ...Object.values(assets.manifest.origins).map(origin => `vendor/${origin.submodule}/${origin.source}`)])) {
  const bytes = readFileSync(path.join(root, name));
  const target = path.join(out, "snapshots", name);
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes);
  metadata.snapshots[name] = digest(bytes);
}
for (const asset of assets.sources) {
  const target = path.join(out, "assets", asset.path);
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, asset.bytes);
}
writeFileSync(path.join(out, "assets/manifest.json"), JSON.stringify(assets.manifest, null, 2) + "\n");
const rows = [];
const normalized = text => text.replace(/^##\s+\d+:\d\d:\d\d\s+/gm, "## TIME ");
const columns = ["solver", "case", "phase", "runtime", "entrypoint", "status", "exitCode", "expectedTrace", "traceCount", "elapsedMs",
  "modelSha256", "solverSha256", "stdoutSha256", "stderrSha256", "captureSha256", "artifactsSha256", "error"];
function save() {
  writeFileSync(path.join(out, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  writeFileSync(path.join(out, "results.json"), JSON.stringify({ preliminary: !values.formal, columns, rows }, null, 2) + "\n");
  writeFileSync(path.join(out, "results.csv"), columns.join(",") + "\n" + rows.map(row => columns.map(name =>
    `"${String(row[name] ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n");
}
function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")).flatMap(entry => {
    assert.ok(!entry.isSymbolicLink(), "Unexpected evidence symlink");
    const name = prefix + entry.name;
    return entry.isDirectory() ? filesBelow(path.join(directory, entry.name), name + "/") : [name];
  });
}
save();
try {
  for (const solver of solvers) {
    const native = loadSolverProbe(probes[solver].native, solver, "native");
    const wasi = loadSolverProbe(probes[solver].wasi, solver, "wasi");
    assert.deepEqual(native.info.source, wasi.info.source, "Matching native/WASI source required");
    const executable = solver === "yices2" ? "yices-smt2" : solver;
    const bin = path.join(out, solver + "-bin"); mkdirSync(bin);
    symlinkSync(native.binaryPath, path.join(bin, executable));
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, LC_ALL: "C", TZ: "UTC", PYTHONDONTWRITEBYTECODE: "1" };
    metadata.probes[solver] = { command: verifyNativeSolver(executable, bin, native.info.artifact.sha256, env),
      native: native.info, wasi: wasi.info,
      version: execFileSync(native.binaryPath, ["--version"], { env, encoding: "utf8", timeout: 10_000 }).trim() };
    metadata.probes[solver].command.resolvedPath = realpathSync(path.join(bin, executable));
    assert.equal(metadata.probes[solver].command.resolvedPath, realpathSync(native.binaryPath));
    mkdirSync(path.join(out, "inputs"), { recursive: true });
    writeFileSync(path.join(out, "inputs", solver + "-native"), native.binary);
    writeFileSync(path.join(out, "inputs", solver + ".wasm"), wasi.binary);
    for (const [runtime, probe] of [["native", native], ["wasi", wasi]]) {
      writeFileSync(path.join(out, "inputs", `${solver}-${runtime}-build.py`), probe.buildScript);
      for (const patch of probe.info.patches) {
        const target = path.join(out, "snapshots", patch.path);
        mkdirSync(path.dirname(target), { recursive: true });
        const bytes = readFileSync(path.join(root, patch.path));
        writeFileSync(target, bytes); metadata.snapshots[patch.path] = digest(bytes);
      }
    }
    for (const [name, probe] of [["native", native], ["wasi", wasi]]) writeFileSync(path.join(out, `${solver}-${name}-build.json`), probe.metadata);
    for (const fixture of fixtures) {
      const recorded = reference.rows.find(row => row.solver === solver && row.case === fixture.name);
      assert.ok(recorded && !recorded.error, "Missing native SBY reference");
      const model = readFileSync(path.join(values.baseline, `${solver}-${fixture.name}`, "result/model/design_smt2.smt2"));
      assert.equal(digest(model), recorded.files["result/model/design_smt2.smt2"].sha256);
      assert.equal(readFileSync(path.join(values.baseline, `${solver}-${fixture.name}`, "top.v"), "utf8"), fixture.source);
      for (const phase of fixture.mode === "prove" ? ["basecase", "induction"] : [fixture.mode]) {
        const label = `${solver}-${fixture.name}-${phase}`;
        const args = ["-s", solver === "yices2" ? "yices" : solver, "--presat", "--noprogress",
          ...(solver === "yices2" ? ["--unroll"] : []), ...(phase === "cover" ? ["-c"] : phase === "induction" ? ["-i"] : []),
          "-t", String(fixture.depth), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw", "--dump-vlogtb", "trace_tb.v", "model.smt2"];
        const expectedCode = ["bmc-violation", "cover-unreached"].includes(fixture.name) || fixture.name === "prove-inconclusive" && phase === "induction" ? 1 : 0;
        const expectedTrace = ["bmc-violation", "cover-reached"].includes(fixture.name) || fixture.name === "prove-inconclusive" && phase === "induction";
        let plain;
        let captured;
        for (const runtime of ["native", "pyodide"]) for (const entrypoint of ["smtbmc", "formal_trace"]) {
          const directory = path.join(out, label, `${runtime}-${entrypoint}`); mkdirSync(directory, { recursive: true });
          const working = path.join(directory, "files"); mkdirSync(working);
          const files = [{ path: "model.smt2", bytes: new Uint8Array(model) }, { path: "top.v", bytes: new TextEncoder().encode(fixture.source) }];
          for (const file of files) writeFileSync(path.join(working, file.path), file.bytes);
          const row = { solver, case: fixture.name, phase, runtime, entrypoint, status: "failed", expectedTrace,
            modelSha256: digest(model), solverSha256: (runtime === "native" ? native : wasi).info.artifact.sha256,
            captureSha256: null, error: null };
          rows.push(row);
          try {
            let result;
            let stdout;
            let stderr;
            const started = performance.now();
            if (runtime === "native") {
              const source = entrypoint === "smtbmc" ? path.join(root, "vendor/yosys/backends/smt2/smtbmc.py") : path.join(values.sources, "formal_trace.py");
              const nativeResult = spawnSync(python, [path.resolve(source), ...args], {
                cwd: working, env, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
              });
              stdout = nativeResult.stdout ?? ""; stderr = nativeResult.stderr ?? "";
              result = { status: nativeResult.error ? "runtime-error" : "exited", exitCode: nativeResult.status,
                signal: nativeResult.signal, error: nativeResult.error?.message ?? null, elapsedMs: performance.now() - started };
            } else {
              const output = []; const errors = [];
              result = await startFormalPython({ ...assets, entrypoint, args, files,
                solvers: { [executable]: { wasm: wasi.binary, sha256: wasi.info.artifact.sha256,
                  exitCodes: solver === "boolector" ? [0, 10, 20] : [0] } },
                workerFactory: nodeFormalWorker, solverWorkerFactory: () => nodeSolverWorker(), timeoutMs: 30_000,
                onStdout: line => output.push(line), onStderr: line => errors.push(line),
              }).completion;
              stdout = output.join(""); stderr = errors.join("");
              for (const file of result.files ?? []) {
                const target = path.join(working, file.path); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, file.bytes);
              }
            }
            writeFileSync(path.join(directory, "stdout.log"), stdout); writeFileSync(path.join(directory, "stderr.log"), stderr);
            const { files: returned, ...state } = result;
            writeFileSync(path.join(directory, "process.json"), JSON.stringify({ args, ...state }, null, 2) + "\n");
            Object.assign(row, { exitCode: result.exitCode, elapsedMs: result.elapsedMs, stdoutSha256: digest(stdout), stderrSha256: digest(stderr) });
            assert.equal(result.status, "exited", result.error);
            assert.equal(result.exitCode, expectedCode, stderr);
            if (runtime === "pyodide") {
              assert.equal(result.integrityVerified, true);
              assert.equal(result.children.length, solver === "bitwuzla" ? 2 : 1);
              assert.ok(result.children.every(child => child.status === "exited" && child.integrityVerified && child.exitCodes.includes(child.exitCode)));
            }
            const names = filesBelow(working);
            const expectedNames = ["model.smt2", "top.v", ...(expectedTrace ? ["trace.vcd", "trace.yw", "trace_tb.v"] : []),
              ...(entrypoint === "formal_trace" ? ["formal-trace.json"] : [])].sort();
            assert.deepEqual([...names].sort(), expectedNames, "Complete artifact inventory");
            const artifacts = Object.fromEntries(names.filter(name => name !== "formal-trace.json").sort().map(name => [name, digest(readFileSync(path.join(working, name)))]));
            row.artifactsSha256 = digest(JSON.stringify(artifacts));
            if (!plain) plain = { stdout: normalized(stdout), stderr, artifacts };
            assert.equal(normalized(stdout), plain.stdout); assert.equal(stderr, plain.stderr); assert.deepEqual(artifacts, plain.artifacts);
            if (entrypoint === "formal_trace") {
              const raw = readFileSync(path.join(working, "formal-trace.json"));
              const trace = JSON.parse(raw);
              row.captureSha256 = digest(raw); row.traceCount = trace.traces.length;
              assert.equal(trace.format_version, 1); assert.equal(trace.upstreamExitCode, expectedCode);
              assert.deepEqual(trace.model, { path: "model.smt2", sha256: digest(model) });
              assert.equal(trace.traces.length, Number(expectedTrace));
              for (const item of trace.traces) {
                assert.equal(item.path, "trace.vcd"); assert.equal(item.sha256, artifacts["trace.vcd"]);
                assert.ok(item.steps.length && item.endTime === item.steps.length);
                assert.deepEqual(item.steps.map(step => step.time), Array.from({ length: item.steps.length }, (_, i) => i));
              }
              if (!captured) captured = raw;
              assert.deepEqual(raw, captured, "Native/Pyodide capture bytes");
            } else row.traceCount = 0;
            row.status = "matched";
          } catch (error) {
            row.error = error.message;
            throw error;
          } finally { save(); }
        }
        console.log(`Matched original and captured SMTBMC: ${label}`);
      }
    }
  }
} finally { save(); }
