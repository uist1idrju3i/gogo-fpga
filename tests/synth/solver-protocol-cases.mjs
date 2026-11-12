import assert from "node:assert/strict";
import { digest, startProbeSession } from "./solver-protocol-helpers.mjs";

export const normalCases = ["incremental-bv", "incremental-array", "long-value", "malformed", "missing-response"];
export const workerCases = ["timeout", "cancel", "busy-timeout", "busy-cancel", "stale", "hash-mismatch", "corrupt-wasm", "worker-crash", "missing-termination", "output-limit"];
export const solverCases = { yices2: ["unsupported-alarm"], z3: ["unknown", "software-fp", "unsupported-hwf"] };
const setup = "(set-option :produce-models true)(set-logic QF_BV)(declare-fun x () (_ BitVec 4))(assert (= x #x1))";

async function expect(session, source, expected) {
  await session.send(source);
  const frame = await session.readResponse();
  if (expected !== null) assert.equal(frame, expected);
  return frame;
}

async function close(session) {
  session.endInput();
  const result = await session.completion;
  assert.equal(result.status, "exited");
  assert.equal(result.exitCode, 0);
  assert.equal(result.framingError, null);
  assert.equal(result.stderr.length, 0);
  await assert.rejects(session.write(new Uint8Array([10])), /closed/);
  assert.throws(() => session.endInput(), /closed/);
  return result;
}

export async function runSolverCase(probe, name, options = {}) {
  const yices = probe.info.solver === "yices2";
  const settings = { ...options };
  if (["long-value", "output-limit"].includes(name)) Object.assign(settings, { capacity: 257, chunkBytes: 1031, stdoutDelayMs: 50 });
  if (["timeout", "missing-termination"].includes(name)) settings.timeoutMs = 3000;
  if (["busy-timeout", "busy-cancel"].includes(name)) Object.assign(settings, { timeoutMs: 3000, capacity: 257, chunkBytes: 1031 });
  if (name === "stale") settings.mode = "stale";
  if (name === "missing-termination") settings.mode = "missing-termination";
  if (name === "worker-crash") settings.mode = "crash";
  if (name === "hash-mismatch") settings.sha256 = "0".repeat(64);
  if (name === "corrupt-wasm") {
    settings.wasm = new Uint8Array(probe.binary);
    settings.wasm[0] ^= 255;
    settings.sha256 = digest(settings.wasm);
  }
  if (name === "output-limit") settings.maxOutputBytes = 128;
  if (name === "unsupported-alarm") settings.args = ["--incremental", "--timeout=1"];
  const session = startProbeSession(probe, settings);
  let result;
  let failure;
  let executed = false;
  try {
    if (["busy-timeout", "busy-cancel"].includes(name)) {
      await expect(session, setup + "(check-sat)", "sat");
      const variables = Array.from({ length: 80 }, (_, index) => `p${index}`);
      const hard = variables.map(v => `(declare-fun ${v} () (_ BitVec 7))(assert (bvult ${v} (_ bv79 7)))`).join("") +
        `(assert (distinct ${variables.join(" ")}))(check-sat)`;
      await session.send(hard);
      executed = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      if (name === "busy-cancel") session.cancel();
      result = await session.completion;
      assert.equal(result.status, name === "busy-cancel" ? "cancelled" : "timeout");
      assert.equal(result.exitCode, null);
      assert.deepEqual(result.frames, ["sat"]);
      assert.equal(result.stderr.length, 0);
    } else if (name === "unsupported-hwf") {
      assert.equal(probe.info.solver, "z3");
      await session.send("(set-logic QF_NRA)(declare-fun r () Real)(assert (> r (/ 1.0 3.0)))(assert (< r (/ 2.0 3.0)))(apply (using-params subpaving :numeral hwf))");
      session.endInput();
      result = await session.completion;
      assert.equal(result.status, "exited");
      if (probe.info.runtime === "wasi") {
        assert.notEqual(result.exitCode, 0);
        assert.ok(result.frames.some(frame => frame.startsWith("(error ") && frame.includes("hardware floating-point rounding is unsupported")));
        assert.ok(!result.frames.some(frame => ["sat", "unsat"].includes(frame)));
      } else {
        assert.equal(result.exitCode, 0);
        assert.ok(result.frames.some(frame => frame.startsWith("(goals")));
      }
      executed = true;
    } else if (name === "software-fp") {
      assert.equal(probe.info.solver, "z3");
      await expect(session, "(set-option :produce-models true)(set-logic QF_FP)(declare-fun f () (_ FloatingPoint 8 24))(assert (= f ((_ to_fp 8 24) #x3f800000)))(check-sat)", "sat");
      executed = true;
      await expect(session, "(get-value ((fp.to_ieee_bv f)))", "(((fp.to_ieee_bv f) #x3f800000))");
      await expect(session, "(push 1)(assert (not (fp.eq (fp.add RNE f f) ((_ to_fp 8 24) #x40000000))))(check-sat)", "unsat");
      await expect(session, "(pop 1)(check-sat)", "sat");
      result = await close(session);
    } else if (name === "unsupported-alarm") {
      assert.equal(probe.info.solver, "yices2");
      assert.equal(probe.info.runtime, "wasi");
      await session.send(setup + "(check-sat)");
      result = await session.completion;
      assert.equal(result.status, "exited");
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout.length, 0);
      assert.match(result.stderr.toString("utf8"), /WASI alarms are unsupported; use a host worker deadline/);
      executed = true;
    } else if (["hash-mismatch", "corrupt-wasm", "worker-crash"].includes(name)) {
      result = await session.completion;
      const expected = { "hash-mismatch": "integrity-error", "corrupt-wasm": "invalid-wasm", "worker-crash": "crashed" }[name];
      assert.equal(result.status, expected);
      assert.equal(result.exitCode, null);
      assert.equal(result.stdout.length, 0);
      assert.equal(result.integrityVerified, name === "corrupt-wasm");
    } else if (name === "incremental-array") {
      const arraySetup = "(set-option :produce-models true)(set-logic QF_ABV)(declare-fun a () (Array (_ BitVec 4) (_ BitVec 4)))(assert (= (select a #x2) #x7))";
      await expect(session, arraySetup + "(check-sat)", "sat");
      executed = true;
      await expect(session, "(get-value ((select a #x2)))", yices ? "(((select a #x2) #b0111))" : "(((select a #x2) #x7))");
      await expect(session, "(push 1)(assert (= (select a #x2) #x8))(check-sat)", "unsat");
      await expect(session, "(pop 1)(check-sat)", "sat");
      assert.match(await expect(session, "(get-model)", null), /define-fun a/);
      result = await close(session);
    } else if (["long-value", "output-limit"].includes(name)) {
      await expect(session, "(set-option :produce-models true)(set-logic QF_BV)(declare-fun big () (_ BitVec 32768))(assert (= big (_ bv1 32768)))(check-sat)", "sat");
      executed = true;
      await session.send("(get-value (big))");
      if (name === "output-limit") {
        result = await session.completion;
        assert.equal(result.status, "output-limit");
        assert.equal(result.exitCode, null);
      } else {
        const value = await session.readResponse();
        assert.equal(value, yices ? `((big\n  #b${"0".repeat(32767)}1))` : `((big #x${"0".repeat(8191)}1))`);
        result = await close(session);
      }
    } else if (name === "malformed") {
      try { await session.send("(assert)"); session.endInput(); }
      catch (error) { assert.match(error.message, /closed|EPIPE|cancel/i); }
      result = await session.completion;
      assert.equal(result.status, "exited");
      if (yices) assert.equal(result.exitCode, 0);
      else assert.notEqual(result.exitCode, 0);
      assert.ok(result.frames.some(frame => frame.startsWith("(error ")));
      assert.ok(!result.frames.some(frame => ["sat", "unsat"].includes(frame)));
      executed = true;
    } else if (name === "missing-response") {
      const missing = assert.rejects(session.readResponse(), /Missing solver response/);
      session.endInput();
      await missing;
      result = await session.completion;
      assert.equal(result.status, "exited");
      assert.equal(result.exitCode, 0);
      assert.equal(result.frames.length, 0);
      executed = true;
    } else if (name === "unknown") {
      assert.equal(probe.info.solver, "z3");
      await expect(session, "(set-option :rlimit 1)" + setup + "(check-sat)", "unknown");
      executed = true;
      assert.match(await expect(session, "(get-info :reason-unknown)", null), /reason-unknown/);
      result = await close(session);
    } else {
      assert.ok(["incremental-bv", "stale", "timeout", "cancel", "missing-termination"].includes(name), `Unknown solver case ${name}`);
      await expect(session, setup + "(check-sat)", "sat");
      executed = true;
      if (name === "timeout") {
        result = await session.completion;
        assert.equal(result.status, "timeout");
        assert.equal(result.exitCode, null);
      } else if (name === "cancel") {
        const writing = session.write(new Uint8Array(1024 * 1024).fill(32));
        const rejected = assert.rejects(writing, /cancel|closed/i);
        session.cancel();
        await rejected;
        result = await session.completion;
        assert.equal(result.status, "cancelled");
        assert.equal(result.exitCode, null);
      } else if (name === "missing-termination") {
        session.endInput();
        result = await session.completion;
        assert.equal(result.status, "timeout");
        assert.equal(result.exitCode, null);
      } else {
        await expect(session, "(get-value (x))", yices ? "((x #b0001))" : "((x #x1))");
        await expect(session, "(push 1)(assert (= x #x2))(check-sat)", "unsat");
        await expect(session, "(pop 1)(check-sat)", "sat");
        assert.match(await expect(session, "(get-model)", null), /define-fun x/);
        result = await close(session);
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    session.cancel();
    result ??= await session.completion;
  }
  return { ...result, case: name, executed, verdict: failure ? "error" : "pass", failure: failure?.message ?? null,
    transmittedSha256: settings.sha256 ?? probe.info.artifact.sha256 };
}

export function compareSolverResults(native, wasi) {
  assert.equal(native.verdict, "pass", native.failure);
  assert.equal(wasi.verdict, "pass", wasi.failure);
  assert.equal(wasi.status, native.status);
  assert.equal(wasi.exitCode, native.exitCode);
  assert.equal(wasi.signal ?? null, native.signal ?? null);
  assert.equal(wasi.framingError ?? null, native.framingError ?? null);
  assert.deepEqual(wasi.stdout, native.stdout);
  assert.deepEqual(wasi.stderr, native.stderr);
  assert.deepEqual(wasi.frames, native.frames);
}
