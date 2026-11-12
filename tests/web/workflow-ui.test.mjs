import assert from "node:assert/strict";
import test from "node:test";
import { createDesignWorkflow, workflowView } from "../../web/lib/workflow-ui.mjs";

function build(flow) {
  flow.rebuild(false);
  flow.send("tools_ready");
  flow.send("build_succeeded");
}

test("workflow follows cold, cached, cancellation and failed-download retry events", () => {
  const changes = [];
  const flow = createDesignWorkflow((change) => changes.push(change.state));
  assert.equal(flow.rebuild(false), "loading_tools");
  flow.send("download_failed");
  assert.equal(flow.view.steps[1], "失敗");
  assert.equal(flow.rebuild(false), "loading_tools");
  flow.send("tools_ready");
  flow.send("build_cancelled");
  assert.equal(flow.state, "editing");
  assert.equal(flow.rebuild(true), "building");
  flow.send("build_succeeded");
  assert.equal(flow.view.primary, "書き込む");
  assert.ok(changes.includes("build_failed"));
});

test("edits invalidate built, written and failed-write artifacts, including direct event dispatch", () => {
  for (const result of [null, "write_succeeded", "write_errored"]) {
    const flow = createDesignWorkflow();
    build(flow);
    if (result) {
      flow.send("write_requested", { board_idcode_matches: true });
      flow.send(result);
    }
    const revision = flow.revision;
    flow.edit();
    assert.ok(flow.revision > revision);
    assert.equal(flow.stale, true);
    assert.equal(flow.canWrite(), false);
    assert.equal(flow.view.primary, "合成し直す");
    assert.notEqual(flow.send("write_requested", { board_idcode_matches: true }), "writing");
    build(flow);
    assert.equal(flow.stale, false);
    assert.equal(flow.canWrite(), true);
  }
});

test("missing and mismatched board guards never begin writing", () => {
  const flow = createDesignWorkflow();
  build(flow);
  assert.equal(flow.send("write_requested"), "built");
  assert.equal(flow.send("write_requested", { board_idcode_matches: false }), "built");
  assert.equal(flow.send("write_requested", { board_idcode_matches: true }), "writing");
  assert.equal(flow.canWrite(), false);
});

test("project activation resets a flow; saved artifacts without freshness evidence fail closed", () => {
  const flow = createDesignWorkflow();
  build(flow);
  flow.reset();
  assert.equal(flow.state, "editing");
  flow.restoreArtifact();
  assert.equal(flow.state, "stale");
  assert.equal(flow.canWrite(), false);
  flow.rebuild(false);
  assert.equal(flow.view.steps[1], "実行中");
  flow.send("download_failed");
  assert.equal(flow.view.steps[1], "失敗");
});

test("verification and warnings have explicit text without changing artifact freshness", () => {
  const flow = createDesignWorkflow();
  build(flow);
  flow.verify("実行中");
  assert.equal(flow.view.steps[2], "実行中");
  flow.verify("成功");
  flow.warnings(true);
  assert.deepEqual(flow.view.steps, ["成功", "警告", "成功", "未実行"]);
  assert.equal(flow.canWrite(), true);
  assert.equal(workflowView("loading_tools").primary, "中止");
});
