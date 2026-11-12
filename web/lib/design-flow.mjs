function freezeTransitions(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTransitions(child);
    Object.freeze(value);
  }
  return value;
}

export const DESIGN_FLOW_INITIAL_STATE = "editing";

export const DESIGN_FLOW_TRANSITIONS = freezeTransitions({
  editing: {
    build_requested: [
      { guard: "tools_not_cached", target: "loading_tools" },
      { guard: "tools_cached", target: "building" },
    ],
    write_requested: [
      { guard: "uploaded_fs_selected && board_idcode_matches", target: "writing" },
    ],
  },
  loading_tools: {
    tools_ready: "building",
    download_failed: "build_failed",
  },
  building: {
    build_succeeded: "built",
    build_errored: "build_failed",
    build_cancelled: "editing",
  },
  built: {
    source_edited: "stale",
    write_requested: [{ guard: "board_idcode_matches", target: "writing" }],
  },
  build_failed: {
    source_edited: "editing",
    build_requested: [
      { guard: "tools_not_cached", target: "loading_tools" },
      { guard: "tools_cached", target: "building" },
    ],
  },
  stale: {
    build_requested: [
      { guard: "tools_not_cached", target: "loading_tools" },
      { guard: "tools_cached", target: "building" },
    ],
    write_requested: [{ actions: ["explain_rebuild_needed"], target: "stale" }],
  },
  writing: {
    write_succeeded: "written",
    write_errored: "write_failed",
  },
  written: {
    source_edited: "stale",
    write_requested: [{ guard: "board_idcode_matches", target: "writing" }],
  },
  write_failed: {
    write_requested: [{ guard: "board_idcode_matches", target: "writing" }],
  },
});

export function transitionDesignFlow(state, event, context = {}) {
  if (!Object.hasOwn(DESIGN_FLOW_TRANSITIONS, state)) {
    throw new RangeError(`Unknown design_flow state: ${String(state)}`);
  }
  const events = DESIGN_FLOW_TRANSITIONS[state];
  if (!Object.hasOwn(events, event)) return state;
  const transitions = typeof events[event] === "string"
    ? [{ target: events[event] }]
    : events[event];
  const selected = transitions.find(({ guard }) => !guard || guard.split(" && ").every(
    (key) => Object.hasOwn(context ?? {}, key) && context[key] === true,
  ));
  return selected?.target ?? state;
}
