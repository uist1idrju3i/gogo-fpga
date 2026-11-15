import { FORMAL_ENGINES, FORMAL_SOLVERS } from "./formal-capabilities.mjs";
import { runSatFormal } from "./formal-sat.mjs";
import { createSatReplay, createSmtReplay, verifySatReplay } from "./formal-replay.mjs";
import { validateFormalProperties } from "./formal-properties.mjs";
import { readSbyStatus, classifySbyStatus } from "./formal-sby-status.mjs";
import { startFormalPython } from "./formal-python-process.mjs";
import { startFormalToolProcess } from "./formal-tool-process.mjs";
import { applyWorkspaceDelta } from "./formal-workspace.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HDL_PATTERN = /\.(?:v|vh|vhd|vhdl)$/i;

function toBytes(content) {
  if (content instanceof Uint8Array) return content;
  if (typeof content === "string") return encoder.encode(content);
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  throw new TypeError("Project file content must be text or bytes");
}

function upsertWorkspace(workspace, path, bytes) {
  const next = workspace.filter((file) => file.path !== path);
  next.push({ path, bytes });
  next.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return next;
}

function chunksText(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return decoder.decode(joined);
}

function result({ jobId, engine, solver, mode, depth, timeoutSeconds, snapshotHash, elapsedMs, kind, status, message = "", inventory = null, vcd = null, replay = null }) {
  return {
    jobId,
    kind,
    status,
    message,
    engine,
    solver,
    mode,
    depth,
    timeoutSeconds,
    snapshotHash,
    elapsedMs,
    inventory,
    vcd,
    replay,
  };
}

function unavailable(input, kind, status, message) {
  const formal = input?.project?.formal ?? {};
  return result({
    jobId: null,
    engine: formal.engine ?? null,
    solver: formal.solver ?? null,
    mode: formal.mode ?? null,
    depth: formal.depth ?? null,
    timeoutSeconds: formal.timeoutSeconds ?? null,
    snapshotHash: input?.snapshotHash ?? null,
    elapsedMs: 0,
    kind,
    status,
    message,
  });
}

export function createFormalRunner({
  startTool = startFormalToolProcess,
  startPython = startFormalPython,
  simulateReplay = null,
  pythonFactory,
  workerFactory,
  solverWorkerFactory,
  wasiWorkerFactory,
  now = () => performance.now(),
} = {}) {
  let active = null;

  function cancelActive(kind) {
    if (!active) return false;
    active.stopped = kind;
    try { active.process?.cancel?.(); } catch { /* The process may already be gone. */ }
    try { simulateReplay?.cancel?.(); } catch { /* The replay may already be gone. */ }
    return true;
  }

  function stop() {
    return cancelActive("cancelled");
  }

  function dispose() {
    stop();
    simulateReplay?.dispose?.();
  }

  async function run(input) {
    if (active) throw new Error("A formal job is already running");
    const project = input?.project;
    let formal = project?.formal;
    if (!formal || typeof formal !== "object") {
      throw new Error("Formal verification is disabled for this project");
    }
    const engine = FORMAL_ENGINES.find((entry) => entry.id === formal.engine);
    const solver = formal.engine === "smtbmc"
      ? FORMAL_SOLVERS.find((entry) => entry.id === formal.solver) ?? null
      : null;
    if (!engine || engine.status !== "probe-verified" || (formal.engine === "smtbmc" && !solver)) {
      return unavailable(input, "unavailable", "engine-unqualified",
        `形式検証 engine ${String(formal.engine)} はこの製品では実行できません`);
    }
    if (formal.engine === "smtbmc" && solver.status !== "probe-verified") {
      return unavailable(input, "unavailable", "solver-unqualified",
        `solver ${solver.id} はこの製品では実行できません`);
    }
    const jobId = crypto.randomUUID();
    const started = now();
    const context = {
      jobId,
      stopped: null,
      timedOut: false,
      process: null,
      workspace: null,
    };
    active = context;
    const deadline = started + formal.timeoutSeconds * 1000;
    const watchdog = setTimeout(() => {
      context.timedOut = true;
      cancelActive("timeout");
    }, formal.timeoutSeconds * 1000);
    try {
      const base = { jobId, engine: engine.id, solver: solver?.id ?? null, mode: formal.mode, depth: formal.depth,
        timeoutSeconds: formal.timeoutSeconds, snapshotHash: input.snapshotHash ?? null };
      let { selected, error } = selectFormalSources(input, formal, base, started, now);
      if (error) return error;
      if (selected.some(file => /\.vhdl?$/i.test(file.path))) {
        const lowered = await lowerVhdl({ input, formal, selected, context, base, started, deadline });
        if (lowered.error) return lowered.error;
        selected = lowered.selected;
        formal = { ...formal, top: formal.top.toLowerCase(), clock: formal.clock?.toLowerCase() ?? null };
        input = { ...input, vhdlLowered: true, files: new Map([...input.files, ...selected.map(file => [file.path, file.bytes])]) };
      }
      if (engine.id === "yosys-sat") {
        return await runSatEngine(input, formal, engine, solver, context, jobId, started, deadline, selected);
      }
      if (engine.id === "smtbmc") {
        return await runSmtEngine(input, formal, engine, solver, context, jobId, started, deadline, selected);
      }
      context.stopped = "unsupported-engine";
      return result({
        jobId, engine: engine.id, solver: solver?.id ?? null, mode: formal.mode, depth: formal.depth,
        timeoutSeconds: formal.timeoutSeconds, snapshotHash: input.snapshotHash ?? null,
        elapsedMs: now() - started, kind: "unavailable", status: "engine-not-wired",
        message: "この形式検証 engine の製品実行はまだ接続されていません",
      });
    } finally {
      clearTimeout(watchdog);
      if (active === context) active = null;
    }
  }

  async function lowerVhdl({ input, formal, selected, context, base, started, deadline }) {
    const fail = (status, message, kind = "tool-error") => ({ error: result({ ...base, elapsedMs: now() - started, kind, status, message }) });
    if (selected.some(file => !/\.vhdl?$/i.test(file.path))) {
      return fail("unsupported-input", "形式検証では VHDL と Verilog を混在させずに選んでください");
    }
    if (!input.assets?.ghdl || !input.assets?.yosys) return fail("missing-assets", "形式検証の GHDL 資材が読み込まれていません");
    const standard = input.project.vhdlStandard ?? "2008";
    if (!["2008", "2019"].includes(standard)) return fail("unsupported-input", "対応していない VHDL 規格です");
    const files = selected.map(file => ({ ...file, path: `model/${file.path}` }));
    const diagnostics = [];
    const job = startTool({
      data: { processId: `${context.jobId}:vhdl`, cwd: "model", files,
        args: ["ghdl", "--synth", standard === "2008" ? "--std=08" : "--std=19", "--out=verilog", "--formal", "-fpsl",
          ...selected.map(file => file.path), "-e", formal.top] },
      ghdl: input.assets.ghdl, wasiWorkerFactory, timeoutMs: Math.max(1, Math.ceil(deadline - now())),
      onStdout() {}, onStderr: chunk => diagnostics.push(chunk),
    });
    context.process = job;
    let outcome;
    try { outcome = await job.completion; }
    finally { if (context.process === job) context.process = null; }
    if (context.stopped) return fail(context.timedOut ? "timeout" : "cancelled", "", context.timedOut ? "timeout" : "cancelled");
    if (outcome.status !== "exited" || outcome.exitCode !== 0 || outcome.integrityVerified !== true) {
      return fail("ghdl-error", chunksText(diagnostics).slice(0, 4096) || outcome.error || `GHDL: ${outcome.status}`);
    }
    const lowered = (await applyWorkspaceDelta(files, outcome.frame)).find(file => file.path === "model/__formal_vhdl.v");
    if (!lowered?.bytes.length) return fail("ghdl-error", "GHDL の変換結果がありません");
    return { selected: [{ path: "__formal_vhdl.v", bytes: lowered.bytes }] };
  }

  async function runSatEngine(input, formal, engine, solver, context, jobId, started, deadline, selected) {
    const base = {
      jobId, engine: engine.id, solver: solver?.id ?? null, mode: formal.mode, depth: formal.depth,
      timeoutSeconds: formal.timeoutSeconds, snapshotHash: input.snapshotHash ?? null,
    };
    const sources = selected.map(({ path }) => path);
    const workspace = [
      ...selected.map(({ path, bytes }) => ({ path: `model/${path}`, bytes })),
      { path: "model/__formal/.keep", bytes: new Uint8Array(0) },
    ];
    if (!input.assets?.yosys) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-assets",
        message: "形式検証の Yosys 資材が読み込まれていません" });
    }
    context.workspace = workspace;
    const execute = async ({ phase, script }) => executeSatPhase({ context, input, phase, script, deadline, now });
    const sat = await runSatFormal({
      execute,
      clock: formal.clock,
      edge: formal.edge,
      sources,
      includeDirs: ["."],
      top: formal.top,
      mode: formal.mode,
      depth: formal.depth,
      timeout: formal.timeoutSeconds,
      internalCells: input.vhdlLowered === true,
    });
    if (context.stopped) {
      return result({ ...base, elapsedMs: now() - started,
        kind: context.timedOut ? "timeout" : context.stopped === "cancelled" ? "cancelled" : context.stopped,
        status: context.timedOut ? "timeout" : context.stopped });
    }
    if (sat.status === "error") {
      return result({ ...base, elapsedMs: now() - started,
        kind: context.timedOut ? "timeout" : "tool-error",
        status: context.timedOut ? "timeout" : "sat-error",
        message: String(sat.message ?? "形式検証の実行に失敗しました") });
    }
    const inventory = sat.inventory ?? null;
    if (sat.status === "counterexample") {
      const replay = await replaySatCounterexample({ input, formal, base, sat, sources, started, now, deadline, simulate: simulateReplay });
      if (context.stopped) return result({ ...base, elapsedMs: now() - started,
        kind: context.timedOut ? "timeout" : "cancelled", status: context.timedOut ? "timeout" : "cancelled" });
      const vcdBytes = typeof sat.vcd === "string" ? encoder.encode(sat.vcd) : sat.vcd;
      return result({ ...base, elapsedMs: now() - started, kind: "counterexample", status: "counterexample",
        inventory, vcd: vcdBytes ? { name: "__formal/witness.vcd", bytes: vcdBytes } : null, replay });
    }
    const kind = sat.status === "bounded-safe" ? "bounded-pass" : sat.status === "proved" ? "proved" : sat.status === "inconsistent-assumptions" ? "unknown" : "tool-error";
    return result({ ...base, elapsedMs: now() - started, kind, status: sat.status, inventory });
  }

  async function executeSatPhase({ context, input, phase, script, deadline, now }) {
    if (context.stopped || now() >= deadline) {
      throw new Error("FORMAL_DEADLINE_EXCEEDED");
    }
    const scriptPath = `model/design_${phase}.ys`;
    context.workspace = upsertWorkspace(context.workspace, scriptPath, encoder.encode(script));
    const stdoutChunks = [];
    const stderrChunks = [];
    const process = startTool({
      data: {
        processId: `${context.jobId}:${phase}`,
        args: ["yosys", "-ql", `design_${phase}.log`, `design_${phase}.ys`],
        cwd: "model",
        files: context.workspace,
      },
      sources: input.assets.sources ?? [],
      manifest: input.assets.manifest,
      solvers: input.assets.solvers,
      yosys: input.assets.yosys,
      pythonFactory,
      workerFactory,
      solverWorkerFactory,
      wasiWorkerFactory,
      timeoutMs: 300_000,
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    context.process = process;
    let outcome;
    try {
      outcome = await process.completion;
    } finally {
      if (context.process === process) context.process = null;
    }
    const stdout = chunksText(stdoutChunks);
    const stderr = chunksText(stderrChunks);
    if (outcome.status !== "exited" || outcome.integrityVerified !== true) {
      const detail = `\n[formal] ${outcome.status}${outcome.error ? `: ${outcome.error}` : ""}`;
      return { exitCode: 1, stdout, stderr: `${stderr}${stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n"}${detail}`, files: new Map() };
    }
    context.workspace = await applyWorkspaceDelta(context.workspace, outcome.frame);
    const files = new Map();
    for (const { path, bytes } of context.workspace) {
      if (path.startsWith("model/")) files.set(path.slice("model/".length), bytes);
    }
    const log = files.get(`design_${phase}.log`);
    const logText = log ? decoder.decode(log) : "";
    const mergedStdout = logText
      ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${logText}`
      : stdout;
    return { exitCode: outcome.exitCode, stdout: mergedStdout, stderr, files };
  }

  async function replaySatCounterexample({ input, formal, base, sat, sources, started, now, deadline, simulate }) {
    if (input.vhdlLowered) return { status: "unavailable", reason: "VHDL 原文の独立シミュレーターは製品に接続されていません" };
    const empty = { status: "unavailable", reason: "再実行シミュレーターが設定されていません" };
    if (!simulate) return empty;
    try {
      const prepare = sat.observations?.find((observation) => observation.phase === "prepare");
      const after = prepare?.files?.get?.("__formal/after.json");
      if (!after) return { status: "unavailable", reason: "形式検証の性質ドキュメントがありません" };
      const document = JSON.parse(decoder.decode(after));
      const witness = typeof sat.witness === "string" ? JSON.parse(sat.witness) : sat.witness;
      const replay = createSatReplay({
        document,
        top: formal.top,
        witness,
        clock: formal.clock,
        edge: formal.edge,
        mode: formal.mode,
        depth: formal.depth,
      });
      const execution = await simulate({ replay, top: formal.top, sources, files: input.files,
        timeoutMs: Math.max(1, Math.ceil(deadline - now())) });
      if (!execution || typeof execution !== "object") {
        return { status: "rejected", reason: "再実行が正常に終了しませんでした" };
      }
      const verdict = verifySatReplay(replay, execution);
      if (verdict.status === "verified") {
        return { status: "verified", steps: verdict.steps, failures: verdict.failures };
      }
      return { status: "rejected", reason: verdict.reason ?? "再実行で違反を再現できませんでした" };
    } catch (error) {
      return { status: "rejected", reason: String(error?.message ?? error).slice(0, 1024) };
    }
  }

  async function runSmtEngine(input, formal, engine, solver, context, jobId, started, deadline, selected) {
    const base = {
      jobId, engine: engine.id, solver: solver.id, mode: formal.mode, depth: formal.depth,
      timeoutSeconds: formal.timeoutSeconds, snapshotHash: input.snapshotHash ?? null,
    };
    const stopped = (kind) => result({ ...base, elapsedMs: now() - started,
      kind: context.timedOut ? "timeout" : kind, status: context.timedOut ? "timeout" : kind });
    const sources = selected.map(({ path }) => path);
    const basenames = new Map();
    for (const path of sources) {
      const base1 = path.split("/").at(-1);
      if (basenames.has(base1)) {
        return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "ambiguous-source",
          message: `SBY は同名のソースを区別できません: ${basenames.get(base1)} と ${path}` });
      }
      basenames.set(base1, path);
    }
    if (formal.sby !== null && formal.sby !== undefined) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "unsupported-input",
        message: "プロジェクト指定の .sby ファイルはまだ接続されていません" });
    }
    if (!Array.isArray(input.assets?.sources) || !input.assets.sources.length || !input.assets?.manifest ||
        !input.assets?.yosys || !input.assets?.solvers) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-assets",
        message: "形式検証の Python/SBY 資材が読み込まれていません" });
    }
    const solverAsset = input.assets.solvers[solver.command];
    if (!Object.hasOwn(input.assets.solvers, solver.command) ||
        !(solverAsset?.wasm instanceof Uint8Array) || solverAsset.wasm.length === 0 ||
        !WebAssembly.validate(solverAsset.wasm) ||
        !/^[0-9a-f]{64}$/.test(solverAsset.sha256 ?? "")) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-assets",
        message: `形式検証の ${solver.label} 資材が読み込まれていません` });
    }
    const sbyName = "formal.sby";
    let document;
    let checkedInventory;
    try {
      context.workspace = [...selected.map(file => ({ path: `model/${file.path}`, bytes: file.bytes })),
        { path: "model/__formal/.keep", bytes: new Uint8Array() }];
      const observation = await executeSatPhase({ context, input, phase: "inventory", deadline, now,
        script: smtInventoryScript({ sources, top: formal.top, internalCells: input.vhdlLowered === true }) });
      if (context.stopped) return stopped("cancelled");
      if (observation.exitCode !== 0) throw new Error(observation.stderr || "Formal inventory failed");
      document = JSON.parse(decoder.decode(observation.files.get("__formal/before.json")));
      checkedInventory = validateFormalProperties(document, document, {
        top: formal.top, clock: formal.clock, edge: formal.edge, mode: formal.mode });
    } catch (error) {
      if (context.stopped) return stopped("cancelled");
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "invalid-properties",
        message: String(error?.message ?? error).slice(0, 1024) });
    }
    const files = [...selected, { path: sbyName, bytes: encoder.encode(generateSby({ sources, top: formal.top, mode: formal.mode, depth: formal.depth, solver,
      internalCells: input.vhdlLowered === true })) }];
    const stdoutParts = [];
    const stderrParts = [];
    const remaining = Math.ceil(deadline - now());
    if (context.stopped || remaining <= 0) return stopped("cancelled");
    const job = startPython({
      sources: input.assets.sources,
      manifest: input.assets.manifest,
      entrypoint: "sby",
      args: ["--yosys", "yosys", "--smtbmc", "yosys-smtbmc", "--witness", "yosys-witness",
        "-j", "1", "-d", "result", sbyName],
      files,
      solvers: input.assets.solvers,
      yosys: input.assets.yosys,
      workerFactory,
      solverWorkerFactory,
      wasiWorkerFactory,
      cwd: null,
      timeoutMs: Math.min(300_000, remaining),
      onStdout: (text) => stdoutParts.push(text),
      onStderr: (text) => stderrParts.push(text),
    });
    context.process = job;
    let sby;
    try {
      sby = await job.completion;
    } finally {
      if (context.process === job) context.process = null;
    }
    const stdout = stdoutParts.join("");
    const stderr = stderrParts.join("");
    if (context.stopped) return stopped(context.stopped === "timeout" ? "timeout" : "cancelled");
    if (sby.status !== "exited") {
      return result({ ...base, elapsedMs: now() - started,
        kind: context.timedOut ? "timeout" : "tool-error",
        status: context.timedOut ? "timeout" : `sby-${sby.status}`,
        message: `SBY の実行に失敗しました: ${String(sby.error ?? sby.status).slice(0, 512)}` });
    }
    const statusFile = (sby.files ?? []).find((file) => file.path === "result/status");
    let sbyStatus;
    try {
      sbyStatus = readSbyStatus(statusFile ? decoder.decode(statusFile.bytes) : "", sby.exitCode, stdout);
    } catch (error) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "sby-status-error",
        message: String(error?.message ?? error).slice(0, 512) });
    }
    let kind;
    try {
      kind = classifySbyStatus(formal.mode, sbyStatus);
    } catch (error) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "sby-status-error",
        message: String(error?.message ?? error).slice(0, 512) });
    }
    const outputFiles = sby.files ?? [];
    if (kind !== "counterexample") {
      return result({ ...base, elapsedMs: now() - started, kind, status: sbyStatus, inventory: checkedInventory });
    }
    const { replay, inventory, vcd } = await replaySmtCounterexample({
      input, formal, solver, selected, outputFiles, context, started, now, deadline, document, simulate: simulateReplay });
    if (context.stopped) return stopped("cancelled");
    return result({ ...base, elapsedMs: now() - started, kind: "counterexample", status: sbyStatus,
      message: stderr.trim() ? stderr.trim().slice(0, 512) : "", inventory: inventory ?? checkedInventory,
      vcd: vcd ? { name: "formal/trace.vcd", bytes: vcd } : null, replay });
  }

  async function replaySmtCounterexample({ input, formal, solver, selected, outputFiles, context, started, now, deadline, document, simulate }) {
    const witnessVcd = outputFiles.find((file) => file.path.endsWith("engine_0/trace.vcd"))?.bytes ?? null;
    const unavailableReplay = (reason) => ({ replay: { status: "unavailable", reason }, inventory: null, vcd: witnessVcd });
    if (input.vhdlLowered) return unavailableReplay("VHDL 原文の独立シミュレーターは製品に接続されていません");
    if (!simulate) return unavailableReplay("再実行シミュレーターが設定されていません");
    try {
      const modelEntries = outputFiles.filter((file) => file.path.endsWith("model/design_smt2.smt2"));
      if (modelEntries.length !== 1) return unavailableReplay("SMT model is missing or ambiguous");
      const modelBytes = modelEntries[0].bytes;
      const inventory = validateFormalProperties(document, document, {
        top: formal.top, clock: formal.clock, edge: formal.edge, mode: formal.mode });
      const remaining = Math.ceil(deadline - now());
      if (context.stopped || remaining <= 0) {
        return { replay: { status: "unavailable", reason: "形式検証ジョブが制限時間に達しました" }, inventory, vcd: witnessVcd };
      }
      const traceStdout = [];
      const traceStderr = [];
      const traceJob = startPython({
        sources: input.assets.sources,
        manifest: input.assets.manifest,
        entrypoint: "formal_trace",
        args: smtTraceArgs(solver, formal.depth),
        files: [...selected, { path: "model.smt2", bytes: modelBytes }],
        solvers: input.assets.solvers,
        yosys: input.assets.yosys,
        workerFactory,
        solverWorkerFactory,
        wasiWorkerFactory,
        cwd: null,
        timeoutMs: Math.min(300_000, remaining),
        onStdout: (text) => traceStdout.push(text),
        onStderr: (text) => traceStderr.push(text),
      });
      context.process = traceJob;
      let trace;
      try {
        trace = await traceJob.completion;
      } finally {
        if (context.process === traceJob) context.process = null;
      }
      if (trace.status !== "exited") {
        return { replay: { status: "unavailable", reason: `トレース記録に失敗しました: ${trace.status}` }, inventory, vcd: witnessVcd };
      }
      const traceFiles = trace.files ?? [];
      const captureEntry = traceFiles.find((file) => file.path === "formal-trace.json");
      const vcdEntry = traceFiles.find((file) => file.path === "trace.vcd");
      if (!captureEntry || !vcdEntry) {
        return { replay: { status: "unavailable", reason: "トレース記録の成果物がありません" }, inventory, vcd: witnessVcd };
      }
      const capture = JSON.parse(decoder.decode(captureEntry.bytes));
      const replay = await createSmtReplay({
        document,
        top: formal.top,
        capture,
        model: modelBytes,
        vcd: vcdEntry.bytes,
        clock: formal.clock,
        edge: formal.edge,
        mode: formal.mode,
        phase: formal.mode === "prove" ? "basecase" : "bmc",
        depth: formal.depth,
      });
      const execution = await simulate({ replay, top: formal.top, sources: selected.map(({ path }) => path), files: input.files,
        timeoutMs: Math.max(1, Math.ceil(deadline - now())) });
      if (!execution || typeof execution !== "object") {
        return { replay: { status: "rejected", reason: "再実行が正常に終了しませんでした" }, inventory, vcd: witnessVcd };
      }
      const verdict = verifySatReplay(replay, execution);
      if (verdict.status === "verified") {
        return { replay: { status: "verified", steps: verdict.steps, failures: verdict.failures }, inventory, vcd: witnessVcd };
      }
      return { replay: { status: "rejected", reason: verdict.reason ?? "再実行で違反を再現できませんでした" }, inventory, vcd: witnessVcd };
    } catch (error) {
      return { replay: { status: "rejected", reason: String(error?.message ?? error).slice(0, 1024) }, inventory: null, vcd: witnessVcd };
    }
  }

  return { run, stop, dispose };
}

function selectFormalSources(input, formal, base, started, now) {
  const paths = formal.files ?? projectFilePaths(input.project);
  const selected = [];
  for (const path of paths) {
    if (!HDL_PATTERN.test(path) || path.startsWith("libraries/")) continue;
    if (!input.files?.has?.(path)) {
      return { error: result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-source",
        message: `形式検証のソースが見つかりません: ${path}` }) };
    }
    const library = input.project.files.find(file => file.path === path)?.library;
    selected.push({ path, bytes: toBytes(input.files.get(path)), ...(library === undefined ? {} : { library }) });
  }
  if (!selected.length) {
    return { error: result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-source",
      message: "形式検証に使える HDL ファイルがありません" }) };
  }
  return { selected };
}

function generateSby({ sources, top, mode, depth, solver, internalCells = false }) {
  const basenames = sources.map((path) => path.split("/").at(-1));
  return [
    "[options]",
    `mode ${mode}`,
    `depth ${depth}`,
    "",
    "[engines]",
    `smtbmc ${solver.smtbmc}`,
    "",
    "[script]",
    `read -formal ${internalCells ? "-icells " : ""}${basenames.map((name) => `"${name}"`).join(" ")}`,
    `prep -top ${top}`,
    "",
    "[files]",
    ...sources,
    "",
  ].join("\n");
}

function smtTraceArgs(solver, depth) {
  return ["-s", solver.smtbmc, "--presat", "--noprogress",
    ...(solver.id === "yices2" ? ["--unroll"] : []),
    "-t", String(depth), "--dump-vcd", "trace.vcd", "--dump-yw", "trace.yw",
    "--dump-vlogtb", "trace_tb.v", "model.smt2"];
}

function smtInventoryScript({ sources, top, internalCells = false }) {
  return [
    ...sources.map((path) => `read_verilog -formal ${internalCells ? "-icells " : ""}"${path}"`),
    `hierarchy -check -top ${top}`,
    "proc",
    "flatten",
    "async2sync",
    "chformal -lower",
    "write_json __formal/before.json",
  ].join("; ");
}

function projectFilePaths(project) {
  if (!Array.isArray(project?.files)) return [];
  return project.files.map((file) => file?.path).filter((path) => typeof path === "string");
}
