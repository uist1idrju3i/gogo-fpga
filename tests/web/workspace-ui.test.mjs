import assert from "node:assert/strict";
import test from "node:test";
import { welcomeDismissed, rememberWelcomeDismissal } from "../../web/lib/workspace-ui.mjs";
import { parseBuildSummary } from "../../web/lib/build-summary.mjs";
import { createBlinkTemplate, generateCst, repairTemplateConstraints } from "../../web/lib/templates.mjs";
import { createDesignWorkflow, workflowView } from "../../web/lib/workflow-ui.mjs";
import { validateProject, prepareProjectInputs } from "../../web/lib/project.mjs";

test("editing has a neutral current marker, not a running status", () => {
  assert.equal(workflowView("editing").steps[0], "現在");
  assert.equal(workflowView("building").steps[1], "実行中");
});

test("welcome dismissal is browser-local and storage failure leaves no false persistence claim", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(welcomeDismissed(storage), false);
  assert.equal(rememberWelcomeDismissal(storage), true);
  assert.equal(welcomeDismissed(storage), true);
  const unavailable = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(welcomeDismissed(unavailable), false);
  assert.equal(rememberWelcomeDismissal(unavailable), false);
  assert.equal(welcomeDismissed(null), false);
});

test("summary uses reported utilization and the last frequency for each clock", () => {
  const summary = parseBuildSummary(new Map([
    ["yosys", "Warning: a warning without a source location\n"],
    ["nextpnr", "Info: Device utilisation:\nInfo: LUT4: 27/ 8640 0%\nInfo: DFF: 24/ 6480 0%\nInfo: Max frequency for clock 'clk': 99.9 MHz\nInfo: Max frequency for clock 'other': 70.0 MHz\nInfo: Max frequency for clock 'clk': 52.85 MHz (PASS at 12.00 MHz)\n"],
  ]));
  assert.deepEqual(summary.resources, [{ name: "LUT4", used: 27, available: 8640 }, { name: "DFF", used: 24, available: 6480 }]);
  assert.deepEqual(summary.clocks, [{ name: "clk", mhz: 52.85 }, { name: "other", mhz: 70 }]);
  assert.equal(summary.warnings, 1);
  assert.equal(parseBuildSummary(new Map([["yosys", "src/top.v:3: warning: located\nWarning: unlocated"]])).warnings, 2);
});

test("summary does not invent metrics for absent or malformed output", () => {
  assert.deepEqual(parseBuildSummary(new Map()), { resources: [], clocks: [], warnings: null });
  const summary = parseBuildSummary(new Map([["nextpnr", "Info: LUT4: 99/ 0 0%\nInfo: DFF: 25/ 10 250%\nInfo: Max frequency for clock 'clk': NaN MHz\n"]]));
  assert.deepEqual(summary.resources, []);
  assert.deepEqual(summary.clocks, []);
});

test("constraint repair uses existing board templates, preserves original bytes and invalidates neither input", async () => {
  const original = createBlinkTemplate("tangnano1k", "verilog");
  const project = { ...original.project, board: "tangnano9k" };
  const oldPath = "constraints/tangnano1k.cst";
  original.files.set(`${oldPath}.bak.txt`, "older backup");
  project.files.push({ path: `${oldPath}.bak.txt` });
  const result = repairTemplateConstraints(project, original.files);
  assert.equal(result.files.get(result.path), generateCst("tangnano9k"));
  assert.equal(result.files.get(`${oldPath}.bak.1.txt`), original.files.get(oldPath));
  assert.equal(result.files.get(`${oldPath}.bak.txt`), "older backup");
  assert.equal(result.files.has(oldPath), false);
  assert.equal(original.files.has(oldPath), true);
  assert.equal(project.files.some(({ path }) => path === result.path), false);
  assert.equal(result.project.files.some(({ path }) => path === oldPath), false);
  assert.deepEqual(validateProject(result.project).errors, []);
  const inputs = await prepareProjectInputs(result.project, result.files);
  assert.deepEqual(inputs.files.filter(({ path }) => path.endsWith(".cst")).map(({ path }) => path), [result.path]);
});

test("cancellation remains visible after status refreshes until the next edit", () => {
  const workflow = createDesignWorkflow();
  workflow.rebuild(false);
  workflow.send("tools_ready");
  workflow.send("build_cancelled");
  workflow.verify("未実行");
  assert.equal(workflow.view.stage, "中止しました");
  workflow.edit();
  assert.equal(workflow.view.stage, "");
  workflow.restoreArtifact();
  assert.equal(workflow.view.stage, "再合成が必要");
});

test("constraint repair rejects missing templates, absent source and existing destination", () => {
  const { project, files } = createBlinkTemplate("tangnano1k", "verilog");
  assert.throws(() => repairTemplateConstraints({ ...project, board: "unknown" }, files), /テンプレートはありません/);
  assert.throws(() => repairTemplateConstraints(project, files), /既にあります/);
  assert.throws(() => repairTemplateConstraints({ ...project, board: "tangnano9k" }, new Map()), /読み込めません/);
  assert.throws(() => repairTemplateConstraints({ ...project, board: "tangnano9k", files: [] }, new Map()), /ありません/);
});
