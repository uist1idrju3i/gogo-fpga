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

globalThis.crossOriginIsolated = true;
const root = path.resolve(import.meta.dirname, "../..");
const web = path.resolve(root, process.env.FORMAL_WEB_ROOT ?? "public_html");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const encode = value => new TextEncoder().encode(value);
mkdirSync(path.join(root, "build"), { recursive: true });
const evidence = mkdtempSync(path.join(root, "build/formal-product-results-"));
const save = (name, data) => writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2) + "\n");
console.log(`Formal product evidence: ${evidence}`);

test("HTTP-delivered SAT assets run through the product runner and actual WASI workers", { timeout: 300_000 }, async t => {
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
    execution: "Node worker_threads; browser interaction is not tested",
  });
  for (const scenario of satFormalCases) {
    await t.test(scenario.name, async () => {
      const project = { version: 4, name: "formal-product", board: "tangnano9k", top: "top", files: [{ path: "top.v" }],
        libraries: [], formal: { engine: "yosys-sat", solver: null, top: "top", mode: scenario.mode ?? "bmc",
          depth: scenario.depth ?? 8, clock: scenario.clock ?? null, edge: scenario.edge ?? "posedge", timeoutSeconds: 30,
          memoryMiB: 512, files: null, sby: null } };
      const files = new Map([["top.v", scenario.source]]);
      const workers = [];
      const runner = createFormalRunner({ wasiWorkerFactory: nodeFormalWasiWorker, startTool(options) {
        const job = startFormalToolProcess(options);
        job.completion.then(({ frame, ...result }) => {
          const delta = frame ? `${scenario.name}-${workers.length}.delta` : null;
          if (delta) writeFileSync(path.join(evidence, delta), frame);
          workers.push({ ...result, delta, frameSize: frame?.length ?? 0 });
        });
        return job;
      } });
      const outcome = await runner.run({ project, files, assets, snapshotHash: await snapshotHash(project, files) });
      save(`${scenario.name}.json`, { expected: scenario.expected, project, source: scenario.source, outcome, workers });
      assert.equal(outcome.status, scenario.expected === "error" ? "sat-error" : scenario.expected);
      assert.ok(workers.length > 0 && workers.every(worker => worker.status === "exited" && worker.integrityVerified === true));
      if (scenario.expected === "counterexample") {
        assert.equal(outcome.replay.status, "unavailable", "A worker test cannot claim independent HDL replay");
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
    await t.test(`delivered Yices2 executes SBY ${fixture.name}`, async () => {
      const stdout = [], stderr = [];
      let execution;
      const runner = createFormalRunner({
        workerFactory: nodeFormalWorker, solverWorkerFactory: nodeSolverWorker, wasiWorkerFactory: nodeFormalWasiWorker,
        startPython(options) {
          const job = startFormalPython({ ...options,
            onStdout: text => { stdout.push(text); options.onStdout(text); },
            onStderr: text => { stderr.push(text); options.onStderr(text); } });
          job.completion.then(value => { execution = value; });
          return job;
        },
      });
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
});
