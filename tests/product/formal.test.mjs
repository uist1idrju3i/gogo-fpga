import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createFormalAssetLoader, snapshotHash } from "../../web/lib/formal-assets.mjs";
import { createFormalRunner } from "../../web/lib/formal-runner.mjs";
import { startFormalPython } from "../../web/lib/formal-python-process.mjs";
import { startFormalToolProcess } from "../../web/lib/formal-tool-process.mjs";
import { createVerifiedAssetLoader } from "../../web/lib/verified-assets.mjs";
import { nodeFormalWorker, nodeFormalWasiWorker } from "../synth/formal-python-helpers.mjs";
import { satFormalCases } from "../synth/formal-sat-cases.mjs";
import { sbyCases, sbyConfig } from "../synth/formal-sby-cases.mjs";
import { nodeSolverWorker } from "../web/solver-process-helpers.mjs";
import { readSbyStatus, classifySbyStatus } from "../../web/lib/formal-sby-status.mjs";
import { smtVhdlReplayCases } from "../synth/formal-smt-vhdl-replay-cases.mjs";
import { createFormalReplaySimulator } from "../../web/lib/formal-simulator.mjs";
import { createSimRunner } from "../../web/lib/sim-runner.mjs";

globalThis.crossOriginIsolated = true;
const root = path.resolve(import.meta.dirname, "../..");
const web = path.resolve(root, process.env.FORMAL_WEB_ROOT ?? "public_html");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => new TextEncoder().encode(value);
mkdirSync(path.join(root, "build"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/formal-product-results-"));
const save = (name, data) => writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + "\n");
console.log(`Formal product evidence: ${evidence}`);

test("HTTP-delivered SAT assets run through the product runner and actual WASI workers", { timeout: 600_000 }, async t => {
  const requests = [];
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    requests.push(pathname);
    const file = path.resolve(web, "." + pathname);
    if (!file.startsWith(web + path.sep)) { response.writeHead(400).end(); return; }
    try {
      const bytes = readFileSync(file);
      response.writeHead(200, { "Content-Type": file.endsWith(".json") ? "application/json" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
        "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" });
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  t.after(() => save("requests.json", requests));
  const baseURL = new URL(`http://127.0.0.1:${server.address().port}/`);
  const replaySimulator = label => {
    const simulate = createFormalReplaySimulator({ runner: createSimRunner({ createSimWorker: () =>
      nodeFormalWorker(new URL("../web/sim-node-worker.mjs", import.meta.url), { workerData: { baseURL: baseURL.href } }) }) });
    const capture = async input => {
      const result = await simulate(input);
      if (result.vcd) writeFileSync(path.join(evidence, `${label}-replay.vcd`), result.vcd);
      save(`${label}-replay.json`, { ...result, vcd: result.vcd ? { size: result.vcd.length, sha256: sha256(result.vcd) } : null });
      return result;
    };
    return Object.assign(capture, { cancel: simulate.cancel, dispose: simulate.dispose });
  };
  const fetchNetwork = globalThis.fetch.bind(globalThis);
  const decoderURL = new URL("../../web/lib/decoders/zstd-decoder.wasm", import.meta.url).href;
  // Node imports the same decoder module from disk; only its URL base differs.
  t.mock.method(globalThis, "fetch", (input, options) => fetchNetwork(String(input) === decoderURL
    ? new URL("lib/decoders/zstd-decoder.wasm", baseURL) : input, options));
  const synthURL = new URL("synth/", baseURL);
  const synthLoader = createVerifiedAssetLoader({ baseURL: synthURL, cacheName: "formal-product-test" });
  const loader = createFormalAssetLoader({ synthURL, formalURL: new URL("formal/", baseURL),
    synthLoader: { ...synthLoader, openCache: async () => null } });
  const assets = await loader.loadForEngine("yosys-sat");
  assert.ok(assets.yosys, "Delivered Yosys assets must pass compressed and decoded hash checks");
  assert.ok(requests.some(url => url.endsWith("yosys.wasm.zst")));
  assert.ok(!requests.some(url => url.startsWith("/formal/")), "SAT must not depend on Python or solver delivery");
  const releaseSource = existsSync(path.join(root, ".git")) ? null : readFileSync(path.join(root, "RELEASE-SOURCE.json"));
  const source = releaseSource ? { commit: JSON.parse(releaseSource).commit, worktree: null,
    sourceKind: "source-archive", releaseSourceSha256: sha256(releaseSource) } : {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    worktree: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }), sourceKind: "git",
  };
  assert.match(source.commit, /^[0-9a-f]{40}$/);
  save("metadata.json", {
    ...source,
    node: process.version, yosysSha256: assets.yosys.sha256, shareSha256: assets.yosys.shareSha256,
    synthManifestSha256: sha256(readFileSync(path.join(web, "synth/manifest.json"))),
    iverilogSha256: Object.fromEntries(["ivlpp", "ivl", "vvp"].map(name =>
      [name, sha256(readFileSync(path.join(web, `iverilog/${name}.wasm`)))])),
    execution: "Node worker_threads; browser interaction is not tested",
  });
  for (const scenario of satFormalCases) {
    await t.test(scenario.name, async t => {
      const project = { version: 4, name: "formal-product", board: "tangnano9k", top: "top", files: [{ path: "top.v" }],
        libraries: [], formal: { engine: "yosys-sat", solver: null, top: "top", mode: scenario.mode ?? "bmc",
          depth: scenario.depth ?? 8, clock: scenario.clock ?? null, edge: scenario.edge ?? "posedge", timeoutSeconds: 30,
          memoryMiB: 512, files: null, sby: null } };
      const files = new Map([["top.v", scenario.source]]);
      const workers = [];
      const runner = createFormalRunner({ simulateReplay: replaySimulator(scenario.name), wasiWorkerFactory: nodeFormalWasiWorker, startTool(options) {
        const job = startFormalToolProcess(options);
        job.completion.then(({ frame, ...result }) => {
          const delta = frame ? `${scenario.name}-${workers.length}.delta` : null;
          if (delta) writeFileSync(path.join(evidence, delta), frame);
          workers.push({ ...result, delta, frameSize: frame?.length ?? 0 });
        });
        return job;
      } });
      t.after(() => runner.dispose());
      const outcome = await runner.run({ project, files, assets, snapshotHash: await snapshotHash(project, files) });
      save(`${scenario.name}.json`, { expected: scenario.expected, project, source: scenario.source, outcome, workers });
      assert.equal(outcome.status, scenario.expected === "error" ? "sat-error" : scenario.expected);
      assert.ok(workers.length > 0 && workers.every(worker => worker.status === "exited" && worker.integrityVerified === true));
      if (scenario.expected === "counterexample") {
        assert.equal(outcome.replay.status, "verified", JSON.stringify(outcome.replay));
      }
    });
  }
  await t.test("delivered Python sources execute upstream SBY setup in Pyodide", async () => {
    const python = await loader.loadPython();
    assert.ok(python?.sources.length > 0);
    const fixture = sbyCases[0], stdout = [], stderr = [];
    const result = await startFormalPython({ ...python, entrypoint: "sby", args: ["-j", "1", "--setup", "-d", "result", "job.sby"],
      files: [{ path: "job.sby", bytes: encode(sbyConfig(fixture, "z3")) }, { path: "top.v", bytes: encode(fixture.source) }],
      solvers: {}, workerFactory: nodeFormalWorker, timeoutMs: 30_000,
      onStdout: text => stdout.push(text), onStderr: text => stderr.push(text) }).completion;
    save("python-setup.json", { ...result, stdout, stderr, files: result.files?.map(file => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) })) });
    assert.equal(result.status, "exited", stderr.join(""));
    assert.equal(result.exitCode, 0, stdout.join(""));
    assert.equal(result.integrityVerified, true);
    assert.equal(stderr.join(""), "");
    assert.match(stdout.join(""), /SETUP COMPLETE \(rc=0\)/);
    assert.equal(result.children.length, 0, "Setup does not qualify any solver");
    assert.ok(result.files.some(file => file.path === "result/src/top.v"));
    assert.ok(result.files.some(file => file.path === "result/config.sby"));
  });
  const smtAssets = await loader.loadForEngine("smtbmc", { solver: "yices2" });
  assert.ok(smtAssets.solvers?.["yices-smt2"], "Product Yices2 delivery is required");
  save("yices2-identity.json", { sha256: smtAssets.solvers["yices-smt2"].sha256,
    manifest: JSON.parse(readFileSync(path.join(web, "formal/solvers/manifest.json"))) });
  for (const fixture of sbyCases) {
    await t.test(`delivered Yices2 executes SBY ${fixture.name}`, async t => {
      const stdout = [], stderr = [];
      let execution;
      const runner = createFormalRunner({
        simulateReplay: replaySimulator(`sby-${fixture.name}`),
        workerFactory: nodeFormalWorker, solverWorkerFactory: nodeSolverWorker, wasiWorkerFactory: nodeFormalWasiWorker,
        startPython(options) {
          const job = startFormalPython({ ...options,
            onStdout: text => { stdout.push(text); options.onStdout(text); },
            onStderr: text => { stderr.push(text); options.onStderr(text); } });
          job.completion.then(value => {
            if (options.entrypoint === "sby") execution = value;
            else save(`sby-${fixture.name}-${options.entrypoint}.json`, value);
          });
          return job;
        },
      });
      t.after(() => runner.dispose());
      const project = { version: 4, name: "yices2-product", board: "tangnano9k", top: "top", files: [{ path: "top.v" }],
        libraries: [], formal: { engine: "smtbmc", solver: "yices2", top: "top", mode: fixture.mode, depth: fixture.depth,
          clock: "clk", edge: "posedge", timeoutSeconds: 60, memoryMiB: 512, files: null, sby: null } };
      const inputs = new Map([["top.v", fixture.source]]);
      const outcome = await runner.run({ project, files: inputs, assets: smtAssets, snapshotHash: await snapshotHash(project, inputs) });
      assert.ok(execution, "The product runner must launch actual SBY");
      const { files = [], ...transport } = execution;
      save(`sby-${fixture.name}.json`, { ...transport, stdout, stderr, outcome,
        files: files.map(file => ({ path: file.path, size: file.bytes.length, sha256: sha256(file.bytes) })) });
      for (const file of files) {
        const target = path.join(evidence, `sby-${fixture.name}`, file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.bytes);
      }
      assert.equal(execution.status, "exited", JSON.stringify({ transport, stdout, stderr }));
      assert.equal(execution.integrityVerified, true);
      const status = readSbyStatus(new TextDecoder().decode(files.find(file => file.path === "result/status")?.bytes), execution.exitCode, stdout.join(""));
      assert.equal(status, fixture.status);
      assert.equal(classifySbyStatus(fixture.mode, status), fixture.kind);
      assert.equal(outcome.status, fixture.status);
      assert.equal(outcome.kind, fixture.kind);
      if (outcome.kind === "counterexample") assert.equal(outcome.replay.status, "verified", JSON.stringify(outcome.replay));
      assert.ok(execution.children.some(child => child.args[0] === "yosys"));
      assert.ok(execution.children.some(child => child.args[0] === "yosys-smtbmc"));
      assert.ok(execution.children.every(child => child.expectedTermination || (child.status === "exited" && child.integrityVerified)));
      const solvers = execution.children.flatMap(child => child.children ?? []).filter(child => child.args[0] === "yices-smt2");
      assert.ok(solvers.length > 0, "SMTBMC must spawn real Yices2");
      assert.ok(solvers.every(child => child.status === "exited" && child.exitCode === 0 && child.integrityVerified &&
        child.sha256 === smtAssets.solvers["yices-smt2"].sha256));
      const database = execFileSync("python3", [path.join(root, "scripts/read-sby-status-db.py"), path.join(evidence, `sby-${fixture.name}/result/status.sqlite`)], { encoding: "utf8" });
      save(`sby-${fixture.name}-sqlite.json`, JSON.parse(database));
      if (fixture.witness) assert.ok(files.some(file => /engine_0\/trace\d*\.vcd$/.test(file.path) && file.bytes.length > 0));
    });
  }
  const vhdlAssets = await loader.loadForEngine("smtbmc", { solver: "yices2", vhdl: true });
  assert.ok(vhdlAssets.ghdl, "Delivered GHDL binary and libraries must pass integrity checks");
  for (const fixture of smtVhdlReplayCases) {
    await t.test(`delivered GHDL and Yices2 execute VHDL ${fixture.name}`, async () => {
      const workers = [];
      const runner = createFormalRunner({ workerFactory: nodeFormalWorker, solverWorkerFactory: nodeSolverWorker,
        wasiWorkerFactory: nodeFormalWasiWorker, startTool(options) {
          const job = startFormalToolProcess(options);
          job.completion.then(({ frame, ...outcome }) => workers.push({ args: options.data.args, ...outcome }));
          return job;
        } });
      const project = { version: 4, name: "vhdl-product", board: "tangnano9k", top: "top", files: [{ path: "top.vhd" }],
        libraries: [], formal: { engine: "smtbmc", solver: "yices2", top: "ToP", mode: fixture.mode, depth: fixture.depth,
          clock: fixture.clock?.toUpperCase() ?? null, edge: fixture.edge, timeoutSeconds: 60, memoryMiB: 512, files: null, sby: null } };
      const files = new Map([["top.vhd", fixture.source]]);
      const outcome = await runner.run({ project, files, assets: vhdlAssets, snapshotHash: await snapshotHash(project, files) });
      save(`vhdl-${fixture.name}.json`, { fixture, project, outcome, workers, ghdlSha256: vhdlAssets.ghdl.sha256,
        librariesSha256: vhdlAssets.ghdl.shareSha256 });
      const rejected = fixture.name === "no-property";
      assert.equal(outcome.status, rejected ? "no-targets" : fixture.status, JSON.stringify(outcome));
      assert.equal(outcome.kind, rejected ? "no-targets" : classifySbyStatus(fixture.mode, fixture.status));
      assert.ok(workers.some(worker => worker.args[0] === "ghdl" && worker.status === "exited" && worker.integrityVerified));
      if (outcome.kind === "counterexample") {
        assert.ok(outcome.vcd?.bytes.length);
        assert.equal(outcome.replay.status, "unavailable", "Lowering does not independently simulate the original VHDL");
      }
    });
  }
  const lifecycleInput = (assets, engine = "yosys-sat") => ({ assets,
    project: { version: 4, name: "lifecycle", board: "tangnano9k", top: "top", files: [{ path: "top.v" }], libraries: [],
      formal: { engine, solver: engine === "smtbmc" ? "yices2" : null, top: "top", mode: "bmc", depth: 3,
        clock: "clk", edge: "posedge", timeoutSeconds: 30, memoryMiB: 512, files: null, sby: null } },
    files: new Map([["top.v", satFormalCases.find(fixture => fixture.name === "depth3").source]]), snapshotHash: "a".repeat(64) });

  await t.test("actual SAT worker stops, times out and restarts without accepting stale results", async t => {
    let cancelNext = true;
    const workers = [];
    const runner = createFormalRunner({ wasiWorkerFactory: nodeFormalWasiWorker, startTool(options) {
      const job = startFormalToolProcess(options);
      job.completion.then(({ frame, ...result }) => workers.push(result));
      if (cancelNext) { cancelNext = false; queueMicrotask(() => runner.stop()); }
      return job;
    } });
    t.after(() => runner.dispose());
    const input = lifecycleInput(assets);
    const cancelled = await runner.run(input);
    assert.equal(cancelled.kind, "cancelled");
    assert.equal(workers[0].status, "cancelled");
    const timeoutInput = lifecycleInput(assets);
    timeoutInput.project.formal.depth = 1000;
    timeoutInput.project.formal.timeoutSeconds = 1;
    timeoutInput.files.set("top.v", "module top(input clk, output reg [127:0] q=0); always @(posedge clk) q<=q+1'b1; always @* assert(q!=128'd999); endmodule");
    const timedOut = await runner.run(timeoutInput);
    assert.equal(timedOut.kind, "timeout", JSON.stringify(timedOut));
    const restarted = await runner.run(input);
    assert.equal(restarted.kind, "bounded-pass");
    assert.equal(restarted.snapshotHash, input.snapshotHash);
    save("lifecycle-sat.json", { cancelled, timedOut, restarted, workers });
  });

  await t.test("actual SBY recursively stops its solver worker and starts a clean job", async t => {
    let stopNext = true;
    let solverWorkers = 0;
    let terminated = 0;
    const runner = createFormalRunner({ workerFactory: nodeFormalWorker, wasiWorkerFactory: nodeFormalWasiWorker,
      solverWorkerFactory() {
        const worker = nodeSolverWorker();
        solverWorkers++;
        const terminate = worker.terminate;
        worker.terminate = () => { terminated++; return terminate(); };
        if (stopNext) { stopNext = false; queueMicrotask(() => runner.stop()); }
        return worker;
      } });
    t.after(() => runner.dispose());
    const input = lifecycleInput(smtAssets, "smtbmc");
    const cancelled = await runner.run(input);
    assert.equal(cancelled.kind, "cancelled");
    assert.ok(solverWorkers > 0 && terminated === solverWorkers, "Stopping SBY must terminate every allocated real solver worker");
    const restarted = await runner.run(input);
    assert.equal(restarted.status, "PASS", JSON.stringify(restarted));
    assert.equal(terminated, solverWorkers);
    save("lifecycle-sby.json", { cancelled, restarted, solverWorkers, terminated });
  });

  await t.test("VHDL lowering rejects corrupt libraries, invalid syntax and mixed HDL before proof", async t => {
    const fixture = smtVhdlReplayCases.find(fixture => fixture.name === "combinational");
    const input = lifecycleInput(vhdlAssets);
    input.project.files = [{ path: "top.vhd" }];
    input.project.formal.top = "TOP";
    input.project.formal.clock = fixture.clock?.toUpperCase() ?? null;
    input.project.formal.depth = fixture.depth;
    input.files = new Map([["top.vhd", fixture.source]]);
    const runner = createFormalRunner({ wasiWorkerFactory: nodeFormalWasiWorker });
    t.after(() => runner.dispose());
    const share = vhdlAssets.ghdl.share.slice();
    share[0] ^= 1;
    const corrupt = await runner.run({ ...input, assets: { ...vhdlAssets, ghdl: { ...vhdlAssets.ghdl, share } } });
    assert.equal(corrupt.status, "ghdl-error");
    const syntax = await runner.run({ ...input, files: new Map([["top.vhd", "entity invalid"]]) });
    assert.equal(syntax.status, "ghdl-error");
    const sat = await runner.run(input);
    assert.equal(sat.kind, "counterexample", JSON.stringify(sat));
    assert.equal(sat.replay.status, "unavailable");
    assert.ok(sat.vcd.bytes.length > 0);
    input.project.files.push({ path: "other.v" });
    input.files.set("other.v", "module other; endmodule");
    const mixed = await runner.run(input);
    assert.equal(mixed.status, "unsupported-input");
    save("vhdl-negative-controls.json", { corrupt, syntax, sat, mixed });
  });
});
