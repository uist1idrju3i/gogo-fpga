#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { root, digest } from "../tests/synth/solver-protocol-helpers.mjs";
import { startSolverProcess } from "../web/lib/solver-process.mjs";
import { nodeSolverWorker } from "../tests/web/solver-process-helpers.mjs";

globalThis.crossOriginIsolated = true;
const { values } = parseArgs({ options: { native: { type: "string" }, wasi: { type: "string" },
  out: { type: "string" }, "unpatched-ids": { type: "boolean", default: false },
  preliminary: { type: "boolean", default: false } } });
for (const key of ["native", "wasi", "out"]) assert.ok(values[key], `Missing --${key}`);
const output = path.resolve(root, values.out);
mkdirSync(output);
const ownScript = readFileSync(new URL(import.meta.url));
writeFileSync(path.join(output, "probe-extra-solver-boundaries.mjs"), ownScript, { flag: "wx" });
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const worktree = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (!values.preliminary) assert.equal(worktree, "", "Formal probe requires a clean worktree");
const settings = { commit, worktree, node: process.version, platform: process.platform, arch: process.arch,
  repository: root,
  os: os.release(), cpus: os.cpus().length, total_memory_bytes: os.totalmem(),
  argv: process.argv, script_sha256: digest(ownScript), phase: values.preliminary ? "preliminary" : "formal-probe",
  unpatched_ids: values["unpatched-ids"] };
writeFileSync(path.join(output, "settings.json"), JSON.stringify(settings, null, 2) + "\n");
const columns = ["case", "runtime", "phase", "status", "binary_sha256", "build_metadata_sha256",
  "input_sha256", "argv_sha256", "stdout_bytes", "stdout_sha256", "stderr_bytes", "stderr_sha256",
  "exit_code", "signal", "process_status", "integrity_verified", "error", "elapsed_ms", "memory_bytes",
  "trace_bytes", "trace_sha256"];
const csv = path.join(output, "results.csv");
const cell = value => `"${String(value ?? "null").replaceAll('"', '""')}"`;
writeFileSync(csv, columns.map(cell).join(",") + "\n", { flag: "wx" });
const ids = [0n, 1n, -1n, 2n, -2n, 2147483647n, 2147483648n, -2147483648n,
  4294967295n, -4294967295n, 4294967297n, -4294967297n, 9223372036854775807n, -9223372036854775807n];
const selected = values["unpatched-ids"] ? ids.filter(id => id !== 2147483648n && id !== -2147483648n) : ids;
const cases = values["unpatched-ids"] ? ["ids"] : ["ids", "trace-plain", "trace-gzip"];
let executions = 0;
for (const runtime of ["native", "wasi"]) {
  const directory = path.resolve(root, values[runtime]);
  const raw = readFileSync(path.join(directory, "metadata.json"));
  const info = JSON.parse(raw);
  assert.equal(info.status, "built");
  assert.equal(info.runtime, runtime);
  assert.equal(info.unpatched_ids, values["unpatched-ids"]);
  assert.equal(info.harness_sha256, digest(readFileSync(path.join(root, "tests/synth/extra-solver-boundary.c"))));
  assert.equal(info.script_sha256, digest(readFileSync(path.join(root, "scripts/build-extra-solver-boundaries.py"))));
  assert.equal(info.source_metadata_sha256, digest(readFileSync(path.join(info.source_build, "metadata.json"))));
  if (!values.preliminary) assert.equal(info.worktree_status, "");
  for (const name of cases) {
    const artifact = info.artifacts[name === "ids" ? "ids" : "trace"];
    const binaryPath = path.resolve(directory, artifact.path);
    assert.ok(binaryPath.startsWith(directory + path.sep));
    const binary = new Uint8Array(readFileSync(binaryPath));
    assert.equal(binary.length, artifact.bytes);
    assert.equal(digest(binary), artifact.sha256);
    const input = Buffer.from(name === "ids" ? "1 sort bitvec 1\n2 input 1\n" : "");
    const gzip = name === "trace-gzip";
    const trace = runtime === "native" ? path.join(output, `${name}.${gzip ? "gz" : "txt"}`)
      : `/tmp/boundary-trace.${gzip ? "gz" : "txt"}`;
    const args = name === "ids" ? (values["unpatched-ids"] ? ["--alias-only"] : []) : [gzip ? "gzip" : "plain", trace];
    const basename = path.join(output, `${runtime}-${name}`);
    writeFileSync(`${basename}.stdin`, input, { flag: "wx" });
    const stdout = [], stderr = [];
    let result;
    const started = performance.now();
    if (runtime === "native") {
      const environment = { ...process.env, LC_ALL: "C", TZ: "UTC" };
      delete environment.BTORAPITRACE;
      const child = spawnSync(binaryPath, args, { cwd: root, input, env: environment, timeout: 30000, maxBuffer: 1024 * 1024 });
      stdout.push(child.stdout ?? Buffer.alloc(0));
      stderr.push(child.stderr ?? Buffer.alloc(0));
      result = { status: child.error ? "native-error" : "exited", exitCode: child.status, signal: child.signal,
        error: child.error?.message ?? null, integrityVerified: true, memoryBytes: null };
    } else {
      const process = startSolverProcess({ wasm: binary, sha256: artifact.sha256, args: ["boundary", ...args],
        capacity: 7, timeoutMs: 30000, workerFactory: () => nodeSolverWorker(),
        onStdout: bytes => stdout.push(Buffer.from(bytes)), onStderr: bytes => stderr.push(Buffer.from(bytes)) });
      for (let offset = 0; offset < input.length; offset += 3) await process.write(input.subarray(offset, offset + 3));
      process.endInput();
      result = { ...await process.completion, signal: null };
    }
    const ended = performance.now();
    const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
    writeFileSync(`${basename}.stdout`, out, { flag: "wx" });
    writeFileSync(`${basename}.stderr`, err, { flag: "wx" });
    const row = { case: name, runtime, phase: settings.phase, status: "failed", binary_sha256: artifact.sha256,
      build_metadata_sha256: digest(raw), input_sha256: digest(input), argv_sha256: digest(JSON.stringify(args)),
      stdout_bytes: out.length, stdout_sha256: digest(out), stderr_bytes: err.length, stderr_sha256: digest(err),
      exit_code: result.exitCode, signal: result.signal, process_status: result.status,
      integrity_verified: result.integrityVerified, error: result.error, elapsed_ms: ended - started,
      memory_bytes: result.memoryBytes, trace_bytes: null, trace_sha256: null };
    try {
      assert.equal(result.integrityVerified, true);
      assert.equal(result.signal, null);
      if (name === "trace-gzip" && runtime === "wasi") {
        assert.equal(result.status, "runtime-error");
        assert.equal(result.exitCode, null);
        assert.equal(out.toString(), "trace-requested\n");
        assert.equal(err.toString(), "Boolector: gzip API traces are unavailable on WASI\n");
      } else {
        assert.equal(result.status, "exited");
        const negative = values["unpatched-ids"] && runtime === "wasi";
        assert.equal(result.exitCode, negative ? 23 : 0);
        assert.equal(err.length, 0);
        if (name === "ids") {
          const expected = selected.map(id => {
            const value = negative ? BigInt.asIntN(32, id) : id;
            const found = value === 1n || value === -1n ? 1 : value === 2n || value === -2n ? 2 : 0;
            return `id=${id} found=${found}\n`;
          }).join("");
          assert.equal(out.toString(), expected);
        } else {
          assert.equal(out.toString(), "trace-requested\ntrace-opened\n");
          if (runtime === "native") {
            const bytes = readFileSync(trace);
            const contents = gzip ? gunzipSync(bytes) : bytes;
            assert.ok(contents.toString().includes("boundary-probe\n"));
            row.trace_bytes = bytes.length;
            row.trace_sha256 = digest(bytes);
          }
        }
      }
      row.status = "pass";
    } finally {
      writeFileSync(`${basename}.json`, JSON.stringify({ args, result, row, started_ms: started, ended_ms: ended }, null, 2) + "\n", { flag: "wx" });
      appendFileSync(csv, columns.map(key => cell(row[key])).join(",") + "\n");
    }
    executions++;
  }
}
const summary = { status: "pass", commit, phase: settings.phase, cases: cases.length, executions,
  csv_sha256: digest(readFileSync(csv)) };
writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(summary));
