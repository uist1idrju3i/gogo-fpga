import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createFormalRunner } from "../../web/lib/formal-runner.mjs";
import { packWorkspaceDelta } from "../../web/lib/formal-workspace.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const satDocument = {
  modules: {
    top: {
      ports: {},
      cells: {
        invariant: { type: "$assert", attributes: { src: "src/top.v:1" }, connections: { A: [2], EN: ["1"] } },
      },
    },
  },
};

const replayDocument = {
  modules: {
    top: {
      ports: { clk: { direction: "input", bits: [2] }, q: { direction: "output", bits: [3, 4] } },
      netnames: { q: { bits: [3, 4], attributes: { init: "00" } } },
      cells: {
        P: { type: "$assert", attributes: { src: "top.v:3.1-3.20" }, connections: { A: [5], EN: ["1"] } },
        state: { type: "$dff", parameters: { CLK_POLARITY: "1" }, connections: { CLK: [2], Q: [3, 4] } },
      },
    },
  },
};

const witness = {
  signal: [
    { name: "clk", wave: "40..." },
    { name: "q", wave: "=.===", data: ["00", "01", "10", "11"] },
  ],
};

const verifiedExecution = {
  status: 0,
  stderr: "",
  vcd: "$timescale 1ps $end\n$scope module __formal_replay $end\n$enddefinitions $end\n#0\n$dumpvars\n$end\n#10000\n",
  stdout: [
    "FORMAL_REPLAY_DRIVE 1", "FORMAL_REPLAY_CHECK 1",
    "FORMAL_REPLAY_DRIVE 2", "FORMAL_REPLAY_CHECK 2",
    "FORMAL_REPLAY_DRIVE 3", "FORMAL_REPLAY_CHECK 3",
    "FORMAL_REPLAY_DRIVE 4", "ERROR: work/top.v:3: ", "       Time: 7000  Scope: __formal_replay.dut.P",
    "FORMAL_REPLAY_CHECK 4", "FORMAL_REPLAY_DONE",
  ].join("\n"),
};

function project({ formal } = {}) {
  const defaultFormal = {
    engine: "yosys-sat",
    solver: null,
    mode: "bmc",
    depth: 4,
    timeoutSeconds: 30,
    memoryMiB: 512,
    top: "top",
    clock: null,
    edge: "posedge",
    files: null,
    sby: null,
  };
  return {
    version: 4,
    name: "formal",
    board: "tangnano9k",
    top: "top",
    files: [{ path: "src/top.v" }],
    simulation: { top: "top_tb", files: null, timeLimitSeconds: 10 },
    libraries: [],
    formal: formal === undefined ? defaultFormal : formal,
  };
}

function input(overrides = {}) {
  return {
    project: project(),
    files: new Map([["src/top.v", "module top; endmodule\n"]]),
    snapshotHash: "a".repeat(64),
    assets: { yosys: { wasm: new Uint8Array([0]), sha256: "b".repeat(64), share: new Uint8Array([1]), shareSha256: "c".repeat(64) } },
    ...overrides,
  };
}

function jsonBytes(value) {
  return encoder.encode(JSON.stringify(value));
}

function fakeTool({ phases, hang = false } = {}) {
  const calls = [];
  const defaults = {
    prepare: { exitCode: 0, stdout: "" },
    presat: { exitCode: 0, stdout: "SAT solving finished - model found:\n" },
    proof: { exitCode: 0, stdout: "SAT proof finished - no model found: SUCCESS!\n" },
  };
  const responses = { ...defaults, ...phases };
  return {
    calls,
    startTool({ data, onStdout, onStderr }) {
      calls.push({ args: [...data.args], cwd: data.cwd, files: data.files.map(({ path }) => path) });
      if (hang) {
        let resolveCompletion;
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        return {
          completion,
          cancel() { resolveCompletion({ status: "cancelled" }); },
        };
      }
      const phase = /design_([a-z]+)\.ys$/.exec(data.args[3])?.[1];
      const response = responses[phase];
      const completion = (async () => {
        let after = data.files;
        if (response.files) {
          after = after
            .filter((file) => !Object.hasOwn(response.files, file.path.slice("model/".length)) || file.path === "model/src/top.v")
            .concat(Object.entries(response.files).map(([path, content]) => ({
              path: `model/${path}`,
              bytes: typeof content === "string" ? encoder.encode(content) : content,
            })));
          after.sort((left, right) => (left.path < right.path ? -1 : 1));
        }
        const frame = await packWorkspaceDelta(data.files, after);
        if (response.stdout) onStdout(encoder.encode(response.stdout));
        if (response.stderr) onStderr(encoder.encode(response.stderr));
        return { status: "exited", exitCode: response.exitCode, integrityVerified: true, frame };
      })();
      return { completion, cancel() {} };
    },
  };
}

function satPhases(document = satDocument) {
  return {
    prepare: { exitCode: 0, stdout: "", files: { "__formal/before.json": jsonBytes(document), "__formal/after.json": jsonBytes(document) } },
  };
}

test("formal runner rejects disabled projects and unqualified engines", async () => {
  const runner = createFormalRunner();
  await assert.rejects(runner.run(input({ project: project({ formal: null }) })), /disabled/);
  const unavailable = await runner.run(input({
    project: project({ formal: { ...project().formal, engine: "abc" } }),
  }));
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(unavailable.status, "engine-unqualified");
  const smt = await runner.run(input({
    project: project({ formal: { ...project().formal, engine: "smtbmc", solver: "yices2" } }),
  }));
  assert.equal(smt.kind, "tool-error");
  assert.equal(smt.status, "missing-assets");
});

test("SAT bounded-safe run returns bounded-pass with inventory", async () => {
  const tool = fakeTool({ phases: satPhases() });
  const runner = createFormalRunner({ startTool: tool.startTool });
  const outcome = await runner.run(input());
  assert.equal(outcome.kind, "bounded-pass");
  assert.equal(outcome.status, "bounded-safe");
  assert.equal(outcome.engine, "yosys-sat");
  assert.equal(outcome.jobId.length > 0, true);
  assert.equal(outcome.inventory.counts.assert, 1);
  assert.equal(tool.calls.length, 3);
  assert.deepEqual(tool.calls.map(({ args }) => args[3]), ["design_prepare.ys", "design_presat.ys", "design_proof.ys"]);
  assert.equal(tool.calls[0].cwd, "model");
});

test("SAT counterexample runs replay and reports verified failures only", async () => {
  const counterexample = {
    proof: {
      exitCode: 1,
      stdout: "SAT proof finished - model found: FAIL!\n",
      files: {
        "__formal/witness.json": jsonBytes(witness),
        "__formal/witness.vcd": "$enddefinitions $end\n#0\n1!\n",
      },
    },
  };
  const tool = fakeTool({ phases: { ...satPhases(replayDocument), ...counterexample } });
  const calls = [];
  const simulateReplay = async (request) => {
    calls.push(request);
    return verifiedExecution;
  };
  const runner = createFormalRunner({ startTool: tool.startTool, simulateReplay });
  const projectWithClock = project({
    formal: { ...project().formal, clock: "clk", depth: 4 },
  });
  const outcome = await runner.run(input({ project: projectWithClock }));
  assert.equal(outcome.kind, "counterexample");
  assert.equal(outcome.replay.status, "verified");
  assert.equal(outcome.replay.steps, 4);
  assert.equal(outcome.replay.failures[0].source, "top.v:3.1-3.20");
  assert.equal(outcome.vcd.name, "__formal/witness.vcd");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].top, "top");
});

test("SAT counterexample without a simulator stays unverified", async () => {
  const counterexample = {
    proof: {
      exitCode: 1,
      stdout: "SAT proof finished - model found: FAIL!\n",
      files: {
        "__formal/witness.json": jsonBytes(witness),
        "__formal/witness.vcd": "$enddefinitions $end\n#0\n1!\n",
      },
    },
  };
  const tool = fakeTool({ phases: { ...satPhases(replayDocument), ...counterexample } });
  const runner = createFormalRunner({ startTool: tool.startTool });
  const outcome = await runner.run(input({
    project: project({ formal: { ...project().formal, clock: "clk" } }),
  }));
  assert.equal(outcome.kind, "counterexample");
  assert.equal(outcome.replay.status, "unavailable");
});

test("SAT counterexample with a rejecting replay stays unverified", async () => {
  const counterexample = {
    proof: {
      exitCode: 1,
      stdout: "SAT proof finished - model found: FAIL!\n",
      files: {
        "__formal/witness.json": jsonBytes(witness),
        "__formal/witness.vcd": "$enddefinitions $end\n#0\n1!\n",
      },
    },
  };
  const tool = fakeTool({ phases: { ...satPhases(replayDocument), ...counterexample } });
  const runner = createFormalRunner({
    startTool: tool.startTool,
    simulateReplay: async () => ({ status: 0, stderr: "", vcd: "", stdout: "" }),
  });
  const outcome = await runner.run(input({
    project: project({ formal: { ...project().formal, clock: "clk" } }),
  }));
  assert.equal(outcome.kind, "counterexample");
  assert.equal(outcome.replay.status, "rejected");
});

test("SAT tool errors, missing assets and unsupported inputs fail closed", async () => {
  const failing = fakeTool({ phases: { prepare: { exitCode: 1, stdout: "", stderr: "boom" } } });
  const runner = createFormalRunner({ startTool: failing.startTool });
  const errored = await runner.run(input());
  assert.equal(errored.kind, "tool-error");
  assert.equal(errored.status, "sat-error");

  const noAssets = createFormalRunner({ startTool: fakeTool({ phases: satPhases() }).startTool });
  const missing = await noAssets.run(input({ assets: {} }));
  assert.equal(missing.kind, "tool-error");
  assert.equal(missing.status, "missing-assets");

  const vhdl = createFormalRunner({ startTool: fakeTool({ phases: satPhases() }).startTool });
  const unsupported = await vhdl.run(input({
    project: project({ formal: { ...project().formal, files: ["src/top.vhd"] } }),
    files: new Map([["src/top.vhd", "entity top is end;"]]),
  }));
  assert.equal(unsupported.kind, "tool-error");
  assert.equal(unsupported.status, "unsupported-input");
});

test("formal runner stops and times out a hanging job", async () => {
  const hanging = fakeTool({ hang: true });
  const runner = createFormalRunner({ startTool: hanging.startTool });
  const pending = runner.run(input());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runner.stop(), true);
  const stopped = await pending;
  assert.equal(stopped.kind, "cancelled");
  assert.equal(stopped.status, "cancelled");

  const slow = fakeTool({ hang: true });
  const runner2 = createFormalRunner({ startTool: slow.startTool });
  const timeoutProject = project({ formal: { ...project().formal, timeoutSeconds: 1 } });
  const timedOut = await runner2.run(input({ project: timeoutProject }));
  assert.equal(timedOut.kind, "timeout");
  assert.equal(timedOut.status, "timeout");
});

test("formal runner rejects concurrent runs", async () => {
  const hanging = fakeTool({ hang: true });
  const runner = createFormalRunner({ startTool: hanging.startTool });
  const pending = runner.run(input());
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(runner.run(input()), /already running/);
  runner.stop();
  await pending;
});

const smtDocument = {
  modules: {
    top: {
      ports: { clk: { direction: "input", bits: [2] }, q: { direction: "output", bits: [3, 4] } },
      netnames: { clk: { bits: [2] }, q: { bits: [3, 4], attributes: { init: "00" } }, hidden: { bits: [5] } },
      cells: {
        P: { type: "$assert", attributes: { src: "top.v:3.1-3.20" }, connections: { A: [5], EN: ["1"] } },
        state: { type: "$dff", parameters: { CLK_POLARITY: "1" }, connections: { CLK: [2], Q: [3, 4] } },
      },
    },
  },
};

function smtAssets() {
  return {
    yosys: input().assets.yosys,
    sources: [{ path: "upstream/sby.py", bytes: new Uint8Array([1]) }],
    manifest: { format: "formal-python/v1", files: {} },
    solvers: { yices: { wasm: new Uint8Array([1]), sha256: "d".repeat(64) } },
  };
}

function smtProject(overrides = {}) {
  return project({
    formal: {
      ...project().formal,
      engine: "smtbmc",
      solver: "yices2",
      clock: "clk",
      depth: 6,
      ...overrides,
    },
  });
}

function smtInput(overrides = {}) {
  return input({ project: smtProject(), assets: smtAssets(), ...overrides });
}

function fakePython({ sby, trace, hang = false } = {}) {
  const calls = [];
  return {
    calls,
    startPython({ entrypoint, args, files, onStdout, onStderr }) {
      calls.push({
        entrypoint,
        args: [...args],
        files: files.map(({ path, bytes }) => ({ path, text: new TextDecoder().decode(bytes) })),
      });
      if (hang) {
        let resolveCompletion;
        const completion = new Promise((resolve) => { resolveCompletion = resolve; });
        return { completion, cancel() { resolveCompletion({ status: "cancelled" }); } };
      }
      const response = entrypoint === "sby" ? sby : trace;
      const completion = (async () => {
        if (response?.stdout) onStdout(response.stdout);
        if (response?.stderr) onStderr(response.stderr);
        return { status: "exited", exitCode: response?.exitCode ?? 0, files: response?.files ?? [] };
      })();
      return { completion, cancel() {} };
    },
  };
}

function sbyStatus(status, code) {
  return {
    exitCode: code,
    stdout: `SBY 0:00:00 [result] DONE (${status}, rc=${code})\n`,
    files: [{ path: "result/status", bytes: encoder.encode(`${status} ${code} 0.0\n`) }],
  };
}

function smtTraceFiles(model, vcd) {
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const capture = {
    format_version: 1,
    model: { path: "model.smt2", sha256: sha(model) },
    upstreamExitCode: 1,
    traces: [{
      path: "trace.vcd",
      sha256: sha(vcd),
      endTime: 4,
      signals: [
        { path: ["top", "clk"], width: 1, clock: "posedge" },
        { path: ["top", "q"], width: 2, clock: null },
        { path: ["top", "hidden"], width: 1, clock: null },
      ],
      steps: ["00", "01", "10", "11"].map((bits, time) => ({ time, values: [
        { path: ["top", "clk"], bits: "0" },
        { path: ["top", "q"], bits },
        { path: ["top", "hidden"], bits: "1" },
      ] })),
    }],
  };
  return [
    { path: "formal-trace.json", bytes: jsonBytes(capture) },
    { path: "trace.vcd", bytes: vcd },
  ];
}

test("SMT bounded run passes SBY status through and generates the .sby", async () => {
  const python = fakePython({ sby: sbyStatus("PASS", 0) });
  const runner = createFormalRunner({ startPython: python.startPython });
  const outcome = await runner.run(smtInput());
  assert.equal(outcome.kind, "bounded-pass");
  assert.equal(outcome.status, "PASS");
  assert.equal(outcome.engine, "smtbmc");
  assert.equal(outcome.solver, "yices2");
  assert.equal(python.calls.length, 1);
  assert.equal(python.calls[0].entrypoint, "sby");
  assert.deepEqual(python.calls[0].args.slice(-1), ["formal.sby"]);
  const sbyFile = python.calls[0].files.find(({ path }) => path === "formal.sby");
  assert.match(sbyFile.text, /mode bmc/);
  assert.match(sbyFile.text, /depth 6/);
  assert.match(sbyFile.text, /smtbmc yices/);
  assert.match(sbyFile.text, /read -formal "top\.v"/);
  assert.match(sbyFile.text, /prep -top top/);
});

test("SMT prove and cover statuses map to their kinds", async () => {
  for (const [mode, status, code, kind] of [
    ["prove", "PASS", 0, "proved"],
    ["cover", "PASS", 0, "covered"],
    ["cover", "FAIL", 2, "unreached"],
  ]) {
    const python = fakePython({ sby: sbyStatus(status, code) });
    const runner = createFormalRunner({ startPython: python.startPython });
    const outcome = await runner.run(input({
      project: smtProject({ mode }),
      assets: smtAssets(),
    }));
    assert.equal(outcome.kind, kind, `${mode}/${status}`);
    assert.equal(outcome.status, status);
  }
});

test("SMT counterexample records the trace and verifies the replay", async () => {
  const model = encoder.encode("source-bound SMT model");
  const vcd = encoder.encode("upstream VCD bytes");
  const python = fakePython({
    sby: { ...sbyStatus("FAIL", 2), files: [
      ...sbyStatus("FAIL", 2).files,
      { path: "result/model/design_smt2.smt2", bytes: model },
      { path: "result/engine_0/trace.vcd", bytes: encoder.encode("$enddefinitions $end\n") },
    ] },
    trace: { exitCode: 0, files: smtTraceFiles(model, vcd) },
  });
  const tool = fakeTool({
    phases: {
      inventory: { exitCode: 0, stdout: "", files: { "__formal/before.json": jsonBytes(smtDocument) } },
    },
  });
  const simulateReplay = async (request) => {
    assert.equal(request.replay.origin, "smt");
    assert.equal(request.top, "top");
    return verifiedExecution;
  };
  const runner = createFormalRunner({
    startTool: tool.startTool,
    startPython: python.startPython,
    simulateReplay,
  });
  const outcome = await runner.run(smtInput());
  assert.equal(outcome.kind, "counterexample");
  assert.equal(outcome.status, "FAIL");
  assert.equal(outcome.replay.status, "verified");
  assert.equal(outcome.replay.failures[0].source, "top.v:3.1-3.20");
  assert.equal(outcome.vcd.name, "formal/trace.vcd");
  assert.equal(outcome.inventory.counts.assert, 1);
  assert.deepEqual(python.calls.map((call) => call.entrypoint), ["sby", "formal_trace"]);
  const trace = python.calls[1];
  assert.equal(trace.args.at(-1), "model.smt2");
  assert.deepEqual(trace.args.slice(0, 2), ["-s", "yices"]);
  assert.ok(trace.files.some(({ path }) => path === "model.smt2"));
  assert.ok(tool.calls.some(({ args }) => args[3] === "design_inventory.ys"));
});

test("SMT counterexample without a simulator stays unverified", async () => {
  const model = encoder.encode("source-bound SMT model");
  const vcd = encoder.encode("upstream VCD bytes");
  const python = fakePython({
    sby: { ...sbyStatus("FAIL", 2), files: [
      ...sbyStatus("FAIL", 2).files,
      { path: "result/model/design_smt2.smt2", bytes: model },
      { path: "result/engine_0/trace.vcd", bytes: encoder.encode("$enddefinitions $end\n") },
    ] },
    trace: { exitCode: 0, files: smtTraceFiles(model, vcd) },
  });
  const tool = fakeTool({
    phases: {
      inventory: { exitCode: 0, stdout: "", files: { "__formal/before.json": jsonBytes(smtDocument) } },
    },
  });
  const runner = createFormalRunner({ startTool: tool.startTool, startPython: python.startPython });
  const outcome = await runner.run(smtInput());
  assert.equal(outcome.kind, "counterexample");
  assert.equal(outcome.replay.status, "unavailable");
  assert.equal(outcome.vcd.name, "formal/trace.vcd");
});

test("SMT unsupported inputs and user .sby files fail closed", async () => {
  const python = fakePython({ sby: sbyStatus("PASS", 0) });
  const runner = createFormalRunner({ startPython: python.startPython });

  const sby = await runner.run(input({
    project: smtProject({ sby: "custom.sby" }),
    assets: smtAssets(),
  }));
  assert.equal(sby.kind, "tool-error");
  assert.equal(sby.status, "unsupported-input");

  const collision = await runner.run(input({
    project: smtProject({ files: ["src/top.v", "lib/top.v"] }),
    files: new Map([["src/top.v", "module top; endmodule\n"], ["lib/top.v", "module top; endmodule\n"]]),
    assets: smtAssets(),
  }));
  assert.equal(collision.kind, "tool-error");
  assert.equal(collision.status, "ambiguous-source");

  const vhdl = await runner.run(input({
    project: smtProject({ files: ["src/top.vhd"] }),
    files: new Map([["src/top.vhd", "entity top is end;"]]),
    assets: smtAssets(),
  }));
  assert.equal(vhdl.kind, "tool-error");
  assert.equal(vhdl.status, "unsupported-input");

  assert.equal(python.calls.length, 0);
});

test("SMT runner stops a hanging python job", async () => {
  const python = fakePython({ hang: true });
  const runner = createFormalRunner({ startPython: python.startPython });
  const pending = runner.run(smtInput());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(runner.stop(), true);
  const stopped = await pending;
  assert.equal(stopped.kind, "cancelled");
  assert.equal(stopped.status, "cancelled");
});
