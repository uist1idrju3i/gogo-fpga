import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { digest, loadSolverProbe, root, verifyNativeSolver } from "../tests/synth/solver-protocol-helpers.mjs";
import { sbyCases, sbyConfig, selectFormalSolvers } from "../tests/synth/formal-sby-cases.mjs";

export { classifySbyStatus, readSbyStatus } from "../web/lib/formal-sby-status.mjs";
import { classifySbyStatus, readSbyStatus } from "../web/lib/formal-sby-status.mjs";

export function probeNative({ manifestFile, out, formal = false, solver, cases = sbyCases, casesFile = null }) {
  const solvers = selectFormalSolvers(solver);
  const directory = path.resolve(out);
  assert.ok(!/[\s;'"`$\\]/.test(directory), "The upstream native shell requires an unambiguous workdir");
  mkdirSync(directory);
  const probes = JSON.parse(readFileSync(manifestFile));
  const python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  const pythonPath = ["vendor/click/src", "vendor/sby/sbysrc", "vendor/yosys/backends/smt2"].map(p => path.join(root, p));
  const yosys = path.join(root, "build/native/yosys");
  const quoted = p => `'${p.replaceAll("'", "'\\''")}'`;
  const nativeCommands = { yosys, "yosys-smtbmc": `${quoted(python)} ${quoted(path.join(root, "vendor/yosys/backends/smt2/smtbmc.py"))}`,
    "yosys-witness": `${quoted(python)} ${quoted(path.join(root, "vendor/yosys/backends/smt2/witness.py"))}` };
  const sourceFiles = ["scripts/probe-upstream-formal.mjs", "tests/synth/formal-sby-cases.mjs", "tests/synth/solver-protocol-helpers.mjs"];
  if (cases !== sbyCases) sourceFiles.push(casesFile);
  const ghdl = path.join(root, "build/ghdl-native/bin/ghdl");
  const lowers = cases.some(fixture => fixture.vhdl);
  if (lowers) for (const input of ["patches/ghdl/formal-verilog.patch", "patches/ghdl/formal-verilog-driver.patch"]) {
    sourceFiles.push(input);
  }
  for (const name of ["sby", "click", "yosys"]) {
    const prefix = name === "yosys" ? "vendor/yosys/backends/smt2" : name === "sby" ? "vendor/sby/sbysrc" : "vendor/click/src/click";
    sourceFiles.push(...filesBelow(path.join(root, prefix)).filter(p => p.endsWith(".py")).map(p => `${prefix}/${p}`));
  }
  const metadata = {
    format: 1, preliminary: !formal, runtime: "native", command: process.argv.slice(1), node: process.version, nativeCommands, solverCommands: {},
    python: execFileSync(python, ["--version"], { encoding: "utf8" }).trim(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }),
    pins: execFileSync("git", ["ls-tree", "HEAD", "vendor/sby", "vendor/yosys", "vendor/click"], { cwd: root, encoding: "utf8" }),
    yosys: { sha256: digest(readFileSync(yosys)), version: execFileSync(yosys, ["-V"], { encoding: "utf8" }).trim() },
    sources: Object.fromEntries(sourceFiles.map(p => [p, digest(readFileSync(path.join(root, p)))])),
  };
  if (lowers) {
    const version = spawnSync(ghdl, ["--version"], { encoding: "utf8", timeout: 30_000 });
    assert.ifError(version.error); assert.equal(version.status, 0);
    metadata.ghdl = { path: "build/ghdl-native/bin/ghdl", sha256: digest(readFileSync(ghdl)), version: `${version.stdout}${version.stderr}`.trim().split("\n")[0] };
  }
  writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  const rows = [];
  for (const solver of solvers) {
    const probe = loadSolverProbe(probes[solver].native, solver, "native");
    const bin = path.join(directory, `${solver}-bin`);
    mkdirSync(bin);
    const executable = solver === "yices2" ? "yices-smt2" : solver;
    symlinkSync(probe.binaryPath, path.join(bin, executable));
    writeFileSync(path.join(bin, "metadata.json"), probe.metadata);
    metadata.solverCommands[solver] = verifyNativeSolver(executable, bin, probe.info.artifact.sha256,
      { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    writeFileSync(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
    for (const fixture of cases) {
      const working = path.join(directory, `${solver}-${fixture.name}`);
      mkdirSync(working);
      if (fixture.vhdl) {
        writeFileSync(path.join(working, "top.vhd"), fixture.source);
        const flags = ["--std=08", ...(fixture.psl ? ["-fpsl"] : [])];
        const analyze = spawnSync(ghdl, ["-a", ...flags, "top.vhd"], { cwd: working, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        writeFileSync(path.join(working, "analyze.stdout"), analyze.stdout ?? "");
        writeFileSync(path.join(working, "analyze.stderr"), analyze.stderr ?? "");
        assert.ifError(analyze.error); assert.equal(analyze.status, 0, analyze.stderr);
        const compiled = spawnSync(ghdl, ["--synth", ...flags, "--out=verilog", "--formal-verilog", "top"], { cwd: working, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
        writeFileSync(path.join(working, "lower.stdout"), compiled.stdout);
        writeFileSync(path.join(working, "lower.stderr"), compiled.stderr);
        assert.ifError(compiled.error); assert.equal(compiled.status, 0, compiled.stderr);
        assert.ok(compiled.stdout.trim(), "Missing lowered Verilog");
        writeFileSync(path.join(working, "top.v"), compiled.stdout);
      } else {
        writeFileSync(path.join(working, "top.v"), fixture.source);
      }
      writeFileSync(path.join(working, "job.sby"), sbyConfig(fixture, solver));
      const args = [path.join(root, "vendor/sby/sbysrc/sby.py"), "--yosys", yosys,
        "--smtbmc", nativeCommands["yosys-smtbmc"], "--witness", nativeCommands["yosys-witness"],
        "-j", "1", "-d", "result", "job.sby"];
      const env = { ...process.env, PYTHONPATH: pythonPath.join(path.delimiter),
        PATH: `${bin}${path.delimiter}${process.env.PATH}`, LC_ALL: "C", TZ: "UTC", MAKEFLAGS: "", PYTHONDONTWRITEBYTECODE: "1" };
      const start = performance.now();
      const result = spawnSync(python, args, { cwd: working, env, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      const elapsedMs = performance.now() - start;
      writeFileSync(path.join(working, "stdout.log"), result.stdout ?? "");
      writeFileSync(path.join(working, "stderr.log"), result.stderr ?? "");
      const statusFile = path.join(working, "result/status");
      const statusText = existsSync(statusFile) ? readFileSync(statusFile, "utf8") : "";
      const row = { solver, case: fixture.name, mode: fixture.mode, depth: fixture.depth, expected: fixture.status,
        status: null, kind: null, exitCode: result.status, signal: result.signal, elapsedMs,
        solverSha256: probe.info.artifact.sha256, error: result.error?.message ?? null, files: {} };
      for (const name of filesBelow(working)) {
        const bytes = readFileSync(path.join(working, name));
        row.files[name] = { bytes: bytes.length, sha256: digest(bytes) };
      }
      try {
        assert.ifError(result.error);
        row.status = readSbyStatus(statusText, result.status, result.stdout);
        assert.equal(row.status, fixture.status);
        assert.match(result.stdout, /starting process/);
        if (fixture.witness) {
          assert.ok(Object.keys(row.files).some(p => /^result\/engine_0\/trace\d*\.vcd$/.test(p)), "Missing required VCD");
          assert.ok(Object.keys(row.files).some(p => /^result\/engine_0\/trace\d*\.yw$/.test(p)), "Missing required Yosys witness");
        }
        row.kind = classifySbyStatus(fixture.mode, row.status);
        assert.equal(row.kind, fixture.kind);
      } catch (error) { row.error ??= error.message; }
      rows.push(row);
      writeFileSync(path.join(working, "result.json"), JSON.stringify(row, null, 2) + "\n");
      console.log(`${solver} ${fixture.name}: ${row.status} (rc=${row.exitCode}) ${row.error ?? row.kind}`);
    }
  }
  writeFileSync(path.join(directory, "results.json"), JSON.stringify({ preliminary: !formal, rows }, null, 2) + "\n");
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { probes: { type: "string" }, out: { type: "string" }, solver: { type: "string" }, suite: { type: "string", default: "standard" }, formal: { type: "boolean", default: false } } });
  assert.ok(values.probes && values.out, "Use --probes MANIFEST --out NEW_DIRECTORY");
  assert.ok(["standard", "replay", "vhdl-replay"].includes(values.suite), "Unknown native fixture suite");
  const suiteFiles = { replay: "../tests/synth/formal-smt-replay-cases.mjs", "vhdl-replay": "../tests/synth/formal-smt-vhdl-replay-cases.mjs" };
  const cases = values.suite === "standard" ? sbyCases : (await import(suiteFiles[values.suite]))[values.suite === "replay" ? "smtReplayCases" : "smtVhdlReplayCases"];
  const rows = probeNative({ manifestFile: values.probes, out: values.out, formal: values.formal, solver: values.solver,
    cases, casesFile: values.suite === "standard" ? null : suiteFiles[values.suite].replace(/^\.\.\//, "") });
  if (rows.some(row => row.error)) process.exitCode = 1;
}
