import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { root, digest, loadSolverProbe } from "../tests/synth/solver-protocol-helpers.mjs";
import { normalCases, workerCases, solverCases, runSolverCase, compareSolverResults } from "../tests/synth/solver-protocol-cases.mjs";
import { startSolverProcess } from "../web/lib/solver-process.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";

const columns = ["phase", "repeat", "solver", "runtime", "case", "verdict", "executed", "status", "exit_code", "signal",
  "elapsed_ms", "native_max_rss_kib", "wasm_memory_bytes", "stdout_bytes", "stderr_bytes", "frame_count", "integrity_verified",
  "binary_sha256", "transmitted_sha256", "source_commit", "binary_build_commit", "harness_commit", "script_sha256",
  "patches_sha256", "gmp_archive_sha256", "sdk_archive_sha256", "metadata_sha256", "stdout_sha256", "stderr_sha256", "frames_sha256", "failure"];
const csv = values => values.map(value => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",") + "\n";
const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

async function version(probe) {
  let stdout;
  if (probe.info.runtime === "native") {
    const result = spawnSync(probe.binaryPath, ["--version"], { timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.equal(result.stderr.length, 0);
    stdout = result.stdout.toString("utf8");
  }
  else {
    const parts = [];
    const errors = [];
    const handle = startSolverProcess({ wasm: probe.binary, sha256: probe.info.artifact.sha256, args: [probe.info.solver, "--version"],
      onStdout: bytes => parts.push(Buffer.from(bytes)), onStderr: bytes => errors.push(Buffer.from(bytes)), workerFactory: () => nodeSolverWorker() });
    handle.endInput();
    const result = await handle.completion;
    assert.equal(result.status, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(Buffer.concat(errors).length, 0);
    stdout = Buffer.concat(parts).toString("utf8");
  }
  assert.ok(stdout.includes(probe.info.source.version.replace(/^(yices|z3)-/, "")));
  return stdout;
}

function negativeControls(native, wasi) {
  const stdout = Buffer.from(wasi.stdout);
  assert.ok(stdout.length > 0);
  stdout[0] ^= 1;
  const changes = { stdout: { stdout }, stderr: { stderr: Buffer.from("injected error\n") }, status: { status: "timeout" },
    exit: { exitCode: 255 }, frames: { frames: ["unknown"] }, signal: { signal: "SIGKILL" }, framing: { framingError: "injected incomplete response" } };
  return Object.entries(changes).map(([control, change]) => {
    assert.throws(() => compareSolverResults(native, { ...wasi, ...change }));
    return { control, detected: true };
  });
}

export async function measure({ manifestFile, out, repeats, aa, preliminary = false }) {
  assert.ok(Number.isInteger(repeats) && repeats >= (preliminary ? 1 : 5) && repeats <= 100);
  assert.ok(Number.isInteger(aa) && aa >= (preliminary ? 0 : 2) && aa <= 100);
  const status = git(["status", "--porcelain"]);
  if (!preliminary) assert.equal(status, "", "Formal trials require an unmodified committed harness");
  const manifestBytes = readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes);
  assert.ok(Object.keys(manifest).length > 0);
  const probes = {};
  for (const [solver, targets] of Object.entries(manifest)) {
    assert.ok(Object.hasOwn(solverCases, solver));
    assert.deepEqual(Object.keys(targets).sort(), ["native", "wasi"]);
    probes[solver] = Object.fromEntries(["native", "wasi"].map(runtime => [runtime, loadSolverProbe(targets[runtime], solver, runtime)]));
  }
  mkdirSync(out);
  const sourceFiles = ["scripts/measure-solver-protocol.mjs", "scripts/audit-solver-protocol.py", "scripts/build-solver-probe.py", "tests/synth/solver-protocol-helpers.mjs", "tests/synth/solver-protocol-cases.mjs",
    "tests/web/solver-process-helpers.mjs", "tests/web/solver-node-worker.mjs", "web/lib/solver-process.mjs", "web/lib/solver-job.mjs",
    "web/lib/byte-pipe.mjs", "web/lib/smt-response-framer.mjs", "web/lib/wasi-p1.mjs"];
  const sources = {};
  for (const targets of Object.values(probes)) for (const probe of Object.values(targets)) {
    for (const patch of probe.info.patches) if (!sourceFiles.includes(patch.path)) sourceFiles.push(patch.path);
  }
  copyFileSync(manifestFile, path.join(out, "probes-manifest.json"));
  for (const file of sourceFiles) {
    sources[file] = digest(readFileSync(path.join(root, file)));
    copyFileSync(path.join(root, file), path.join(out, file.replaceAll("/", "__")));
  }
  globalThis.crossOriginIsolated = true;
  const metadata = { format: 3, purpose: "Node real-solver protocol contracts, not browser isolation or HDL proofs", preliminary,
    repeats, aa, harnessCommit: git(["rev-parse", "HEAD"]), worktreeStatus: status, sources, manifestSha256: digest(manifestBytes),
    argv: process.argv.slice(2), node: process.version, v8: process.versions.v8,
    timeVersion: execFileSync("/usr/bin/time", ["--version"], { encoding: "utf8" }),
    host: { os: os.platform(), release: os.release(), arch: os.arch(), cpus: os.availableParallelism(), memory: os.totalmem() },
    submodules: git(["submodule", "status"]), startedUnix: Date.now() / 1000, probes: {} };
  json(path.join(out, "metadata-start.json"), metadata);
  for (const [solver, targets] of Object.entries(probes)) for (const [runtime, probe] of Object.entries(targets)) {
    const label = `${solver}-${runtime}`;
    writeFileSync(path.join(out, label + ".metadata.json"), probe.metadata, { flag: "wx" });
    writeFileSync(path.join(out, label + ".build-script.py"), probe.buildScript, { flag: "wx" });
    for (const command of probe.info.commands) {
      assert.match(command.label, /^[a-zA-Z0-9-]+$/);
      assert.equal(command.exit_status, 0);
      const log = readFileSync(path.join(probe.directory, command.label + ".log"));
      assert.equal(digest(log), command.log_sha256);
      writeFileSync(path.join(out, `${label}.${command.label}.log`), log, { flag: "wx" });
    }
    metadata.probes[label] = { ...probe.info, metadataSha256: probe.metadataSha256, actualVersion: await version(probe) };
  }
  const csvFile = path.join(out, "results.csv");
  writeFileSync(csvFile, csv(columns), { flag: "wx" });
  const controls = [];
  const errors = [];
  const previous = new Map();
  let rowCount = 0;
  for (const phase of aa ? ["aa", preliminary ? "preliminary" : "formal"] : [preliminary ? "preliminary" : "formal"]) {
    const count = phase === "aa" ? aa : repeats;
    for (let repeat = 1; repeat <= count; repeat++) for (const [solver, targets] of Object.entries(probes)) {
      for (const name of [...normalCases, ...workerCases, ...solverCases[solver]]) {
        const paired = normalCases.includes(name) || ["unknown", "software-fp"].includes(name);
        const runtimes = paired || name === "unsupported-hwf" ? (repeat % 2 ? ["native", "wasi"] : ["wasi", "native"]) : ["wasi"];
        const results = {};
        for (const runtime of runtimes) {
          const probe = targets[runtime];
          const label = `${phase}-${repeat}-${solver}-${runtime}-${name}`;
          const result = await runSolverCase(probe, name, { resourceFile: path.join(out, label + ".rss") });
          results[runtime] = result;
          for (const field of ["stdout", "stderr"]) writeFileSync(path.join(out, label + "." + field), result[field], { flag: "wx" });
          writeFileSync(path.join(out, label + ".frames.json"), JSON.stringify(result.frames), { flag: "wx" });
          const record = { ...result, stdout: undefined, stderr: undefined, frames: undefined };
          json(path.join(out, label + ".json"), record);
          const row = [phase, repeat, solver, runtime, name, result.verdict, result.executed, result.status, result.exitCode, result.signal,
            result.elapsedMs, result.nativeMaxRssKiB, result.memoryBytes, result.stdout.length, result.stderr.length, result.frames.length, result.integrityVerified,
            probe.info.artifact.sha256, result.transmittedSha256, probe.info.source.commit, probe.info.base_commit, metadata.harnessCommit,
            probe.info.script_sha256, digest(JSON.stringify(probe.info.patches)), probe.info.gmp?.archive_sha256, probe.info.wasi_sdk?.archive_sha256,
            probe.metadataSha256, result.stdoutSha256, result.stderrSha256, result.framesSha256, result.failure];
          appendFileSync(csvFile, csv(row));
          rowCount++;
          if (result.verdict !== "pass") errors.push({ label, message: result.failure });
          try {
            if (runtime === "native") assert.ok(result.nativeMaxRssKiB > 0);
            assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0);
            if (phase === "aa" && (paired || ["stale", "unsupported-alarm", "unsupported-hwf"].includes(name))) {
              const key = `${solver}-${runtime}-${name}`;
              if (previous.has(key)) compareSolverResults(previous.get(key), result);
              previous.set(key, result);
            }
          } catch (error) { errors.push({ label, message: error.message }); }
          console.log(`${label}: ${result.verdict} ${result.status} exit=${result.exitCode}`);
        }
        if (paired) try {
          compareSolverResults(results.native, results.wasi);
          if (["incremental-bv", "incremental-array", "long-value"].includes(name)) controls.push({ phase, repeat, solver, case: name,
            derivedFrom: `${phase}-${repeat}-${solver}-wasi-${name}`, checks: negativeControls(results.native, results.wasi) });
        } catch (error) { errors.push({ label: `${phase}-${repeat}-${solver}-${name}-parity`, message: error.message }); }
      }
    }
  }
  metadata.endedUnix = Date.now() / 1000;
  metadata.rows = rowCount;
  metadata.errors = errors;
  metadata.status = errors.length ? "error" : "pass";
  metadata.csvSha256 = digest(readFileSync(csvFile));
  json(path.join(out, "controls.json"), controls);
  json(path.join(out, "metadata-end.json"), metadata);
  assert.equal(errors.length, 0, `Protocol failures: ${JSON.stringify(errors).slice(0, 3000)}`);
  return metadata;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const { values } = parseArgs({ options: { probes: { type: "string" }, out: { type: "string" }, repeats: { type: "string", default: "5" },
    aa: { type: "string", default: "2" }, preliminary: { type: "boolean", default: false } } });
  assert.ok(values.probes && values.out, "--probes and --out are required");
  await measure({ manifestFile: path.resolve(values.probes), out: path.resolve(values.out), repeats: Number(values.repeats), aa: Number(values.aa), preliminary: values.preliminary });
}
