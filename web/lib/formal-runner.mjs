import { FORMAL_ENGINES, FORMAL_SOLVERS } from "./formal-capabilities.mjs";
import { runSatFormal } from "./formal-sat.mjs";
import { createSatReplay, verifySatReplay } from "./formal-replay.mjs";
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
    return true;
  }

  function stop() {
    return cancelActive("cancelled");
  }

  function dispose() {
    stop();
  }

  async function run(input) {
    if (active) throw new Error("A formal job is already running");
    const project = input?.project;
    const formal = project?.formal;
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
      if (engine.id === "yosys-sat") {
        return await runSatEngine(input, formal, engine, solver, context, jobId, started, deadline);
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

  async function runSatEngine(input, formal, engine, solver, context, jobId, started, deadline) {
    const base = {
      jobId, engine: engine.id, solver: solver?.id ?? null, mode: formal.mode, depth: formal.depth,
      timeoutSeconds: formal.timeoutSeconds, snapshotHash: input.snapshotHash ?? null,
    };
    const paths = formal.files ?? projectFilePaths(input.project);
    const sources = [];
    const workspace = [];
    for (const path of paths) {
      if (!HDL_PATTERN.test(path) || path.startsWith("libraries/")) continue;
      if (!/\.v$/i.test(path) && !/\.vh$/i.test(path)) {
        return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "unsupported-input",
          message: "Yosys SAT の形式検証には Verilog ファイルを選んでください" });
      }
      if (!input.files?.has?.(path)) {
        return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-source",
          message: `形式検証のソースが見つかりません: ${path}` });
      }
      const bytes = toBytes(input.files.get(path));
      sources.push(path);
      workspace.push({ path: `model/${path}`, bytes });
    }
    if (!sources.length) {
      return result({ ...base, elapsedMs: now() - started, kind: "tool-error", status: "missing-source",
        message: "形式検証に使える Verilog ファイルがありません" });
    }
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
      const replay = await replaySatCounterexample({ input, formal, base, sat, sources, started, now, simulate: simulateReplay });
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
    return { exitCode: outcome.exitCode, stdout, stderr, files };
  }

  async function replaySatCounterexample({ input, formal, base, sat, sources, started, now, simulate }) {
    const empty = { status: "unavailable", reason: "replay simulator is not configured" };
    if (!simulate) return empty;
    try {
      const prepare = sat.observations?.find((observation) => observation.phase === "prepare");
      const after = prepare?.files?.get?.("__formal/after.json");
      if (!after) return { status: "unavailable", reason: "formal property document is missing" };
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
      const execution = await simulate({ replay, top: formal.top, sources, files: input.files });
      if (!execution || typeof execution !== "object") {
        return { status: "rejected", reason: "Replay execution did not finish normally" };
      }
      const verdict = verifySatReplay(replay, execution);
      if (verdict.status === "verified") {
        return { status: "verified", steps: verdict.steps, failures: verdict.failures };
      }
      return { status: "rejected", reason: verdict.reason ?? "Replay did not reproduce the violation" };
    } catch (error) {
      return { status: "rejected", reason: String(error?.message ?? error).slice(0, 1024) };
    }
  }

  return { run, stop, dispose };
}

function projectFilePaths(project) {
  if (!Array.isArray(project?.files)) return [];
  return project.files.map((file) => file?.path).filter((path) => typeof path === "string");
}
