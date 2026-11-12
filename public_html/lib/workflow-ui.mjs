import { DESIGN_FLOW_INITIAL_STATE, transitionDesignFlow } from "./design-flow.mjs";

export function workflowView(state, { stale = false, warnings = false, verification = "未実行", lastEvent = null } = {}) {
  const busy = ["loading_tools", "building"].includes(state);
  const built = ["built", "writing", "written", "write_failed"].includes(state);
  const synthesis = busy ? "実行中" : state === "build_failed" ? "失敗"
    : stale || state === "stale" ? "古い" : built ? warnings ? "警告" : "成功" : "未実行";
  return {
    stage: busy ? null : stale || state === "stale" ? "再合成が必要"
      : state === "editing" && lastEvent === "build_cancelled" ? "中止しました"
      : ({ built: "ビルド完了", written: "書き込み完了", writing: "書き込み中", write_failed: "書き込み失敗", build_failed: "ビルド失敗" }[state] ?? ""),
    primary: busy ? "中止" : stale || state === "stale" ? "合成し直す" : built ? "書き込む" : "合成・配置配線",
    steps: [["editing", "stale", "build_failed"].includes(state) ? "現在" : "成功", synthesis,
      verification, stale ? "古い" : state === "writing" ? "実行中" : state === "written" ? "成功" : state === "write_failed" ? "失敗" : "未実行"],
  };
}

export function createDesignWorkflow(onChange = () => {}) {
  let state = DESIGN_FLOW_INITIAL_STATE;
  let revision = 0;
  let artifact = false;
  let stale = false;
  let warnings = false;
  let verification = "未実行";
  let lastEvent = null;
  const notify = () => onChange({ state, stale, revision, ...workflowView(state, { stale, warnings, verification, lastEvent }) });
  return {
    get state() { return state; },
    get revision() { return revision; },
    get stale() { return stale; },
    get view() { return { state, stale, ...workflowView(state, { stale, warnings, verification, lastEvent }) }; },
    send(event, guards = {}) {
      if (event === "write_requested" && !this.canWrite()) return state;
      state = transitionDesignFlow(state, event, guards);
      lastEvent = event;
      if (event === "write_requested" && state === "writing") artifact = true;
      if (event === "build_succeeded" && state === "built") { artifact = true; stale = false; }
      notify();
      return state;
    },
    edit() {
      lastEvent = null;
      revision += 1;
      stale ||= artifact;
      state = transitionDesignFlow(state, "source_edited");
      if (state === "write_failed") state = DESIGN_FLOW_INITIAL_STATE;
      verification = "未実行";
      notify();
    },
    reset() {
      lastEvent = null;
      revision += 1;
      state = DESIGN_FLOW_INITIAL_STATE;
      artifact = false;
      stale = false;
      warnings = false;
      verification = "未実行";
      notify();
    },
    restoreArtifact() {
      lastEvent = null;
      artifact = true;
      stale = true;
      state = transitionDesignFlow("built", "source_edited");
      notify();
    },
    rebuild(cached) {
      if (!["editing", "stale", "build_failed"].includes(state)) state = DESIGN_FLOW_INITIAL_STATE;
      stale ||= artifact;
      verification = "未実行";
      return this.send("build_requested", { tools_cached: cached, tools_not_cached: !cached });
    },
    verify(status) { verification = status; notify(); },
    warnings(value) { warnings = value; notify(); },
    canWrite() { return !stale && !["stale", "loading_tools", "building", "writing", "build_failed"].includes(state); },
  };
}
