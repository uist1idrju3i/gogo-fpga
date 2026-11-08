import assert from "node:assert/strict";
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
  assert.equal(smt.kind, "unavailable");
  assert.equal(smt.status, "engine-not-wired");
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
