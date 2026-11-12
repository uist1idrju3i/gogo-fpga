import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  DESIGN_FLOW_INITIAL_STATE,
  DESIGN_FLOW_TRANSITIONS,
  transitionDesignFlow,
} from "../../web/lib/design-flow.mjs";

const output = new URL("../../docs/ux/out/", import.meta.url);
const projections = readdirSync(output).filter((name) => /design_flow.*xstate.*\.json$/.test(name));
assert.equal(projections.length, 1, "Exactly one generated design_flow projection is required");
const contract = JSON.parse(readFileSync(new URL(projections[0], output), "utf8"));

test("design_flow state/event/target/guard/action table exactly matches the generated contract", () => {
  assert.equal(contract.id, "design_flow");
  assert.equal(DESIGN_FLOW_INITIAL_STATE, contract.initial);
  assert.deepEqual(DESIGN_FLOW_TRANSITIONS, Object.fromEntries(
    Object.entries(contract.states).map(([state, value]) => [state, value.on ?? {}]),
  ));
});

test("every state and event follows the contract for every guard context", () => {
  const guards = [...new Set(Object.values(contract.states).flatMap(({ on = {} }) => (
    Object.values(on).flatMap((value) => Array.isArray(value)
      ? value.flatMap(({ guard }) => guard?.split(" && ") ?? []) : [])
  )))];
  const events = [...new Set(Object.values(contract.states).flatMap(({ on = {} }) => Object.keys(on)))];
  for (let bits = 0; bits < 2 ** guards.length; bits += 1) {
    const context = Object.freeze(Object.fromEntries(guards.map((guard, index) => (
      [guard, Boolean(bits & (1 << index))]
    ))));
    for (const [state, { on = {} }] of Object.entries(contract.states)) {
      for (const event of [...events, "unknown_event", "constructor"]) {
        const rule = on[event];
        let expected = state;
        if (Object.hasOwn(on, event)) {
          if (typeof rule === "string") expected = rule;
          else {
            const eligible = rule.filter(({ guard }) => (
              guard === undefined || guard.split(" && ").map((key) => context[key]).every(Boolean)
            ));
            if (eligible.length) expected = eligible[0].target;
          }
        }
        assert.equal(transitionDesignFlow(state, event, context), expected,
          `${state}/${event}/${JSON.stringify(context)}`);
      }
    }
  }
});

test("missing, null, non-boolean and inherited guards cannot authorize writing", () => {
  for (const context of [undefined, null, {}, { board_idcode_matches: 1 },
    { board_idcode_matches: "true" }, Object.create({ board_idcode_matches: true })]) {
    assert.equal(transitionDesignFlow("built", "write_requested", context), "built");
  }
  assert.equal(transitionDesignFlow("editing", "write_requested", {
    uploaded_fs_selected: true,
  }), "editing");
  assert.equal(transitionDesignFlow("editing", "write_requested", {
    board_idcode_matches: true,
  }), "editing");
  assert.equal(transitionDesignFlow("editing", "write_requested", {
    uploaded_fs_selected: true, board_idcode_matches: true,
  }), "writing");
});

test("stale artifacts never enter writing, even when all write guards pass", () => {
  assert.equal(transitionDesignFlow("stale", "write_requested", {
    uploaded_fs_selected: true, board_idcode_matches: true,
  }), "stale");
});

test("initial, failure, cancellation and retry transitions preserve caller context", () => {
  const context = Object.freeze({ tools_not_cached: true, tools_cached: false });
  let state = transitionDesignFlow(DESIGN_FLOW_INITIAL_STATE, "build_requested", context);
  assert.equal(state, "loading_tools");
  state = transitionDesignFlow(state, "download_failed");
  assert.equal(state, "build_failed");
  assert.equal(transitionDesignFlow(state, "build_requested"), state);
  state = transitionDesignFlow(state, "build_requested", { tools_cached: true });
  assert.equal(state, "building");
  assert.equal(transitionDesignFlow(state, "build_cancelled"), "editing");
  assert.equal(transitionDesignFlow(state, "build_errored"), "build_failed");
  assert.equal(transitionDesignFlow("writing", "write_errored"), "write_failed");
  assert.equal(transitionDesignFlow("write_failed", "write_requested", {
    board_idcode_matches: true,
  }), "writing");
  assert.deepEqual(context, { tools_not_cached: true, tools_cached: false });
});

test("invalid states fail closed and the transition table is immutable", () => {
  for (const state of [undefined, null, "", "unknown", "constructor"]) {
    assert.throws(() => transitionDesignFlow(state, "write_requested"), RangeError);
  }
  assert.equal(transitionDesignFlow("editing"), "editing");
  assert.throws(() => { DESIGN_FLOW_TRANSITIONS.built.write_requested[0].guard = ""; }, TypeError);
  assert.throws(() => { DESIGN_FLOW_TRANSITIONS.stale.write_requested[0].actions.push("write"); }, TypeError);
});

test("failed downloads and stale builds retry through the appropriate tool-loading state", () => {
  for (const state of ["build_failed", "stale"]) {
    assert.equal(transitionDesignFlow(state, "build_requested", { tools_not_cached: true }), "loading_tools");
    assert.equal(transitionDesignFlow(state, "build_requested", { tools_cached: true }), "building");
    assert.equal(transitionDesignFlow(state, "build_requested"), state);
  }
});

test("all built and retry write paths reject a mismatched board", () => {
  for (const state of ["built", "written", "write_failed"]) {
    assert.equal(transitionDesignFlow(state, "write_requested", { board_idcode_matches: false }), state);
    assert.equal(transitionDesignFlow(state, "write_requested"), state);
    assert.equal(transitionDesignFlow(state, "write_requested", { board_idcode_matches: true }), "writing");
  }
});
