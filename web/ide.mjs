import { createOpfsStore } from "./lib/project-store.mjs";
import {
  findConstraintBoardMismatch,
  prepareProjectInputs,
  validatePath,
  validateProjectName,
} from "./lib/project.mjs";
import { createBlinkTemplate } from "./lib/templates.mjs";
import {
  exportProjectZip,
  importProjectZip,
} from "./lib/project-zip.bundle.mjs";
import { createHdlEditor, languageForPath } from "./editor/editor.bundle.mjs";
import { createBuildRunner } from "./lib/build-runner.mjs";
import { parseToolDiagnostics } from "./lib/tool-diagnostics.mjs";
import { createSimRunner, vcdRootScopes } from "./lib/sim-runner.mjs";
import { isLibraryPath } from "./lib/libraries.mjs";
import { createLibrarySelector } from "./lib/library-selector.mjs";
import { FORMAL_ENGINES, FORMAL_SOLVERS } from "./lib/formal-capabilities.mjs";
import { createFormalAssetLoader, snapshotHash } from "./lib/formal-assets.mjs";
import { createFormalRunner } from "./lib/formal-runner.mjs";

const UI_STATE_PREFIX = "toolchain.ide.";

const FORMAL_KIND_LABELS = {
  "bounded-pass": "境界付きで安全を確認しました（bmc の範囲内です）",
  proved: "証明できました。",
  covered: "cover の目標に到達しました。",
  unreached: "cover の目標に到達しませんでした。",
  counterexample: "反例が見つかりました。",
  unknown: "判定できませんでした。",
  "tool-error": "ツールがエラーを返しました。",
  timeout: "時間上限に達しました。",
  cancelled: "停止しました。",
  unavailable: "この製品では実行できません。",
};

function isBinaryPath(path) {
  return typeof path === "string" && /\.(?:fs|bin)$/.test(path);
}

function decodeContent(content) {
  return typeof content === "string"
    ? content
    : new TextDecoder().decode(content);
}

function templateForPath(path) {
  if (path.endsWith(".v")) {
    return "// 最小の例です。ピン割り当ては含みません。\nmodule top;\nendmodule\n";
  }
  if (path.endsWith(".vhd") || path.endsWith(".vhdl")) {
    return [
      "-- 最小の例です。ピン割り当ては含みません。",
      "library ieee;",
      "use ieee.std_logic_1164.all;",
      "",
      "entity top is",
      "end entity;",
      "",
      "architecture rtl of top is",
      "begin",
      "end architecture;",
      "",
    ].join("\n");
  }
  if (path.endsWith(".cst")) return "// ピン割り当ては未設定です。\n";
  return isBinaryPath(path) ? new Uint8Array() : "";
}

function readUiState(name, project) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`${UI_STATE_PREFIX}${name}`) ?? "null",
    );
    const filePaths = new Set(
      project.files.filter(({ path }) => !isBinaryPath(path)).map(({ path }) => path),
    );
    const openTabs = Array.isArray(saved?.openTabs)
      ? [...new Set(saved.openTabs.filter((path) => filePaths.has(path)))]
      : [];
    const activeTab = filePaths.has(saved?.activeTab)
      ? saved.activeTab
      : openTabs[0] ?? null;
    return { openTabs, activeTab };
  } catch {
    return { openTabs: [], activeTab: null };
  }
}

export function initializeIde({
  form,
  boardSelect,
  programLog,
  BOARDS,
  onFsSourceChange = () => {},
  onBuildStateChange = () => {},
  onSimulationStateChange = () => {},
  canStartSimulation = () => true,
  canChangeLibraries = () => true,
}) {
  const store = createOpfsStore(navigator.storage);
  const projectName = document.querySelector("#project-name");
  const projectSelect = document.querySelector("#project-select");
  const projectActionStatus = document.querySelector("#project-action-status");
  const newProjectButton = document.querySelector("#new-project-button");
  const exportProjectButton = document.querySelector("#export-project-button");
  const importProjectButton = document.querySelector("#import-project-button");
  const projectZipInput = document.querySelector("#project-zip-input");
  const projectStatus = document.querySelector("#project-status");
  const boardFpga = document.querySelector("#board-fpga");
  const boardIdcode = document.querySelector("#board-idcode");
  const boardTarget = document.querySelector("#board-target");
  const boardConstraintWarning = document.querySelector("#board-constraint-warning");
  const fileList = document.querySelector("#file-list");
  const addFileButton = document.querySelector("#add-file-button");
  const renameFileButton = document.querySelector("#rename-file-button");
  const deleteFileButton = document.querySelector("#delete-file-button");
  const fileTabs = document.querySelector("#editor-tabs");
  const editorMount = document.querySelector("#editor-mount");
  const problemList = document.querySelector("#problem-list");
  const problemEmpty = document.querySelector("#problem-empty");
  const fileDialog = document.querySelector("#file-dialog");
  const fileDialogHeading = document.querySelector("#file-dialog-heading");
  const filePathInput = document.querySelector("#file-path-input");
  const fileUploadField = document.querySelector("#file-upload-field");
  const fileContentInput = document.querySelector("#file-content-input");
  const filePathError = document.querySelector("#file-path-error");
  const filePathSaveButton = document.querySelector("#file-path-save");
  const filePathCancelButton = document.querySelector("#file-path-cancel");
  const fileInput = document.querySelector("#bitstream-file");
  const fsSource = document.querySelector("#fs-source");
  const fsFileInfo = document.querySelector("#fs-file-info");
  const localFsField = document.querySelector("#local-fs-field");
  const newProjectDialog = document.querySelector("#new-project-dialog");
  const newProjectNameInput = document.querySelector("#new-project-name");
  const newProjectBoardSelect = document.querySelector("#new-project-board");
  const newProjectLanguageSelect = document.querySelector("#new-project-language");
  const newProjectStandardField = document.querySelector("#new-project-standard-field");
  const newProjectStandardSelect = document.querySelector("#new-project-standard");
  const newProjectError = document.querySelector("#new-project-error");
  const newProjectCreateButton = document.querySelector("#new-project-create");
  const newProjectCancelButton = document.querySelector("#new-project-cancel");
  const tabButtons = [...document.querySelectorAll("[data-bottom-tab]")];
  const tabPanels = [...document.querySelectorAll("[data-bottom-panel]")];
  const editorPane = document.querySelector(".editor-pane");
  const ideLayout = editorPane.closest(".ide-layout");
  const toggleFilesButton = document.querySelector("#toggle-files-pane");
  const toggleBoardButton = document.querySelector("#toggle-board-pane");
  const filesPane = document.querySelector("#files-pane");
  const boardPane = document.querySelector("#board-pane");
  const closeFilesPaneButton = document.querySelector("#close-files-pane");
  const closeBoardPaneButton = document.querySelector("#close-board-pane");
  const synthesisButton = document.querySelector("#synthesis-button");
  const synthesisStage = document.querySelector("#synthesis-stage");
  const synthesisReason = document.querySelector("#synthesis-reason");
  const simulationButton = document.querySelector("#simulation-button");
  const simulationStatus = document.querySelector("#simulation-status");
  const simulationReason = document.querySelector("#simulation-reason");
  const simulationTop = document.querySelector("#simulation-top");
  const simulationFiles = document.querySelector("#simulation-files");
  const simulationTimeLimit = document.querySelector("#simulation-time-limit");
  const formalButton = document.querySelector("#formal-button");
  const formalStatus = document.querySelector("#formal-status");
  const formalReason = document.querySelector("#formal-reason");
  const formalEngine = document.querySelector("#formal-engine");
  const formalSolver = document.querySelector("#formal-solver");
  const formalSolverField = document.querySelector("#formal-solver-field");
  const formalMode = document.querySelector("#formal-mode");
  const formalDepth = document.querySelector("#formal-depth");
  const formalTimeout = document.querySelector("#formal-timeout");
  const formalTop = document.querySelector("#formal-top");
  const formalClock = document.querySelector("#formal-clock");
  const formalEdge = document.querySelector("#formal-edge");
  const formalFilesNote = document.querySelector("#formal-files-note");
  const formalFiles = document.querySelector("#formal-files");
  const waveformStatus = document.querySelector("#waveform-status");
  const waveformFileField = document.querySelector("#waveform-file-field");
  const waveformFile = document.querySelector("#waveform-file");
  const surferMount = document.querySelector("#surfer-mount");
  const waveDownload = document.querySelector("#wave-download");
  const waveDownloadLink = document.querySelector("#wave-download-link");
  const synthesisAssetSize = document.querySelector("#synthesis-asset-size");
  const vhdlStandardControl = document.querySelector("#vhdl-standard-control");
  const vhdlStandardSelect = document.querySelector("#vhdl-standard");
  const programButton = document.querySelector("#program-button");

  let project = null;
  let fileContents = new Map();
  let openTabs = [];
  let activeTab = null;
  let selectedPath = null;
  let editor = null;
  let saveTimer = null;
  let pendingSave = Promise.resolve();
  let fileDialogMode = "add";
  let projectSwitchVersion = 0;
  const buildRunner = createBuildRunner();
  const simRunner = createSimRunner();
  const formalRunner = createFormalRunner();
  const formalAssetLoader = createFormalAssetLoader();
  let buildRunning = false;
  let simulationRunning = false;
  let formalRunning = false;
  let formalVersion = 0;
  let surferFrame = null;
  let surferBridgePromise = null;
  let resolveSurferBridge = null;
  let vcdObjectUrl = null;
  let currentVcd = null;
  let availableVcds = [];
  let waveformVersion = 0;
  let simulationVersion = 0;
  let buildVersion = 0;
  let libraryBusy = false;

  function setWorkspaceBusy(busy) {
    libraryBusy = busy;
    for (const control of [
      newProjectButton, newProjectCreateButton, projectSelect,
      importProjectButton, projectZipInput, exportProjectButton,
      boardSelect, addFileButton, filePathSaveButton, vhdlStandardSelect,
    ]) control.disabled = busy;
    updateEditor();
    renderFileList();
    updateSynthesisControls();
    onBuildStateChange(busy || buildRunning || simulationRunning);
  }

  async function withWorkspaceChange(action) {
    if (libraryBusy || !project) return;
    setWorkspaceBusy(true);
    void librarySelector.refresh(false);
    try {
      return await action();
    } finally {
      setWorkspaceBusy(false);
      void librarySelector.refresh(false);
    }
  }

  const librarySelector = createLibrarySelector(document.querySelector("#library-selector"), {
    getWorkspace: () => ({ project, files: fileContents }),
    getBoard: () => boardSelect.value,
    canChange: () => !libraryBusy && canChangeLibraries(),
    beforeChange: () => {
      buildVersion += 1;
      simulationVersion += 1;
      buildRunner.cancel();
      simRunner.stop();
      formalRunner.stop();
      buildRunning = false;
      simulationRunning = false;
      formalRunning = false;
      onSimulationStateChange(false);
      onBuildStateChange(libraryBusy);
      clearWaveforms();
      synthesisStage.textContent = "処理を停止し、構成の変更を準備しています。";
      simulationStatus.textContent = "";
      simulationStatus.dataset.outcome = "";
      updateSynthesisControls();
    },
    onChange: async (next, original) => {
      await flushPendingSave();
      if (project !== original) throw new Error("プロジェクトが切り替わったため保存を中止しました。");
      await store.save(next.project, next.files);
      if (project === original) {
        activateProject(next);
        synthesisStage.textContent = "ライブラリーを変更し、ビルド結果を破棄しました。";
      }
    },
    onBusy: setWorkspaceBusy,
  });

  function appendProjectLog(message) {
    const prior = programLog.textContent.trim();
    programLog.textContent = prior ? `${prior}\n${message}` : message;
  }

  function updateBoardInformation() {
    const board = boardSelect.options[boardSelect.selectedIndex];
    const boardData = board?.value
      ? JSON.parse(board.dataset.board ?? "null")
      : null;
    if (!boardData) return;
    boardFpga.textContent = boardData.part;
    const idcodes = Array.isArray(boardData.idcodes)
      ? boardData.idcodes
      : [boardData.idcode];
    boardIdcode.textContent = idcodes
      .map((idcode) => `0x${idcode.toString(16).toUpperCase().padStart(8, "0")}`)
      .join("、");
    boardTarget.textContent = boardData.writeTargets.join("、");
    const mismatch = findConstraintBoardMismatch(project);
    boardConstraintWarning.hidden = !mismatch;
    boardConstraintWarning.textContent = mismatch
      ? `この制約ファイル（${mismatch.path}）は ${mismatch.boardName} 用です。ピン割り当ては T2 で編集できるようになります。`
      : "";
  }

  function setProjectStatus(message) {
    projectStatus.textContent = message;
  }

  function setProjectActionStatus(message) {
    projectActionStatus.textContent = message;
  }

  function renderFsSource(useDefault = false, preferredPath = null) {
    const paths = (project?.files ?? [])
      .map(({ path }) => path)
      .filter((path) => path.endsWith(".fs"));
    const previous = fsSource.value;
    fsSource.replaceChildren();
    for (const path of paths) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      fsSource.append(option);
    }
    const localOption = document.createElement("option");
    localOption.value = "local";
    localOption.textContent = "パソコンのファイルから選ぶ";
    fsSource.append(localOption);
    const selected = preferredPath && paths.includes(preferredPath)
      ? preferredPath
      : !useDefault &&
      (previous === "local" || paths.includes(previous))
      ? previous
      : paths.length === 1
        ? paths[0]
        : "local";
    fsSource.value = selected;
    localFsField.hidden = selected !== "local";
    if (selected === "local") {
      onFsSourceChange(null);
    } else {
      const content = fileContents.get(selected);
      const bytes = content instanceof Uint8Array
        ? new Uint8Array(content)
        : new TextEncoder().encode(content ?? "");
      onFsSourceChange({
        name: selected.split("/").at(-1),
        bytes,
      });
    }
  }

  function updateSynthesisControls() {
    const hasVerilog = (project?.files ?? []).some(({ path }) =>
      /\.(?:v|sv)$/i.test(path)
    );
    const hasVhdl = (project?.files ?? []).some(({ path }) => /\.(?:vhd|vhdl)$/i.test(path));
    const board = BOARDS.find(({ id }) => id === boardSelect.value);
    const supported = (hasVerilog || hasVhdl) && Boolean(board);
    synthesisButton.disabled = (!supported && !buildRunning) || simulationRunning || formalRunning || libraryBusy;
    synthesisReason.textContent = supported ? "" : "HDL プロジェクトを開いてください。";
    vhdlStandardControl.hidden = !hasVhdl;
    if (project) {
      project.vhdlStandard ??= "2008";
      vhdlStandardSelect.value = project.vhdlStandard;
    }
    if (board) {
      void fetch(new URL("./synth/manifest.json", import.meta.url))
        .then((response) => response.json())
        .then((manifest) => {
          const paths = new Set([
            "yosys.wasm",
            "nextpnr-himbaechel-gowin.wasm",
            "yosys-share.tar",
            `chipdb/chipdb-${board.nextpnrFamily}.bin`,
          ]);
          if (hasVhdl) {
            paths.add("ghdl-synth.wasm");
            paths.add("libraries.tar");
          }
          const size = manifest.assets
            .filter(({ path }) => paths.has(path))
            .reduce((total, asset) => total + asset.size, 0);
          synthesisAssetSize.textContent =
            `初回は約 ${(size / 1_000_000).toFixed(1)} MB を読み込みます`;
        })
        .catch(() => {
          synthesisAssetSize.textContent = "合成資材の情報を読み込めません。";
        });
    }
    updateSimulationControls();
    updateFormalControls();
  }

  function renderSimulationSettings() {
    if (!project) return;
    project.simulation ??= {
      top: "top_tb",
      files: null,
      timeLimitSeconds: 10,
    };
    simulationTop.value = project.simulation.top;
    simulationTimeLimit.value = String(project.simulation.timeLimitSeconds);
    simulationFiles.replaceChildren();
    const candidates = project.files.filter(({ path }) => !isLibraryPath(path) && /\.(?:v|vh)$/i.test(path));
    for (const { path } of candidates) {
      const label = document.createElement("label");
      label.className = "simulation-file";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = path;
      input.checked =
        project.simulation.files === null || project.simulation.files.includes(path);
      input.disabled = simulationRunning || buildRunning || libraryBusy;
      input.addEventListener("change", () => {
        project.simulation.files = [
          ...simulationFiles.querySelectorAll("input:checked"),
        ].map((element) => element.value);
        scheduleSave();
      });
      label.append(input, document.createTextNode(path));
      simulationFiles.append(label);
    }
    if (candidates.length === 0) {
      const message = document.createElement("p");
      message.textContent = "Verilog ファイルがありません。";
      simulationFiles.append(message);
    }
  }

  function updateSimulationControls() {
    const paths = (project?.files ?? []).map(({ path }) => path);
    const hasVerilog = paths.some((path) => /\.(?:v|vh)$/i.test(path));
    const hasVhdl = paths.some((path) => /\.(?:vhd|vhdl)$/i.test(path));
    const board = BOARDS.find(({ id }) => id === boardSelect.value);
    simulationButton.textContent = simulationRunning ? "停止" : "シミュレーション";
    simulationReason.textContent = !hasVerilog && hasVhdl
      ? "VHDL のシミュレーションはできません（Verilog の testbench を使ってください）"
      : !hasVerilog
        ? "Verilog ファイルを含むプロジェクトを開いてください。"
        : "";
    simulationButton.disabled = libraryBusy || (simulationRunning
      ? false
      : !hasVerilog || !board || buildRunning || formalRunning || !canStartSimulation() ||
        !simulationTop.value.trim() ||
        !Number.isInteger(Number(simulationTimeLimit.value)) ||
        Number(simulationTimeLimit.value) < 1 ||
        Number(simulationTimeLimit.value) > 120);
    simulationTop.disabled = simulationRunning || buildRunning || libraryBusy;
    simulationTimeLimit.disabled = simulationRunning || buildRunning || libraryBusy;
    renderSimulationSettings();
  }

  function syncFormalSolverOptions() {
    const previous = formalSolver.value;
    formalSolver.replaceChildren();
    for (const entry of FORMAL_SOLVERS) {
      const option = document.createElement("option");
      option.value = entry.id;
      option.textContent = entry.status === "probe-verified" ? entry.label : `${entry.label}（未対応）`;
      option.disabled = entry.status !== "probe-verified";
      formalSolver.append(option);
    }
    if (FORMAL_SOLVERS.some((entry) => entry.id === previous)) {
      formalSolver.value = previous;
    }
  }

  function syncFormalModeOptions() {
    const engine = FORMAL_ENGINES.find((entry) => entry.id === formalEngine.value);
    const modes = engine?.modes ?? ["bmc"];
    const previous = formalMode.value;
    formalMode.replaceChildren();
    for (const mode of modes) {
      const option = document.createElement("option");
      option.value = mode;
      option.textContent = { bmc: "bmc（境界付き）", prove: "prove（証明）", cover: "cover（到達性）" }[mode] ?? mode;
      formalMode.append(option);
    }
    if (modes.includes(previous)) formalMode.value = previous;
  }

  function renderFormalSettings() {
    if (!project) return;
    const candidates = project.files.filter(({ path }) => !isLibraryPath(path) && /\.(?:v|vh)$/i.test(path));
    project.formal ??= {
      engine: "yosys-sat",
      solver: null,
      mode: "bmc",
      depth: 20,
      timeoutSeconds: 30,
      memoryMiB: 512,
      top: "top",
      clock: null,
      edge: "posedge",
      files: candidates.filter(({ path }) => !/(?:^|\/)[^/]*_tb\.v$/i.test(path)).map(({ path }) => path),
      sby: null,
    };
    const formal = project.formal;
    formalEngine.value = FORMAL_ENGINES.some((entry) => entry.id === formal.engine) ? formal.engine : "yosys-sat";
    syncFormalSolverOptions();
    if (formal.engine === "smtbmc" && !formal.solver) formal.solver = FORMAL_SOLVERS[0]?.id ?? null;
    formalSolver.value = formal.solver ?? "";
    syncFormalModeOptions();
    const engineEntry = FORMAL_ENGINES.find((entry) => entry.id === formalEngine.value);
    if (!engineEntry?.modes.includes(formal.mode)) {
      formal.mode = "bmc";
      formalMode.value = "bmc";
    } else {
      formalMode.value = formal.mode;
    }
    formalDepth.value = String(formal.depth);
    formalTimeout.value = String(formal.timeoutSeconds);
    formalTop.value = formal.top;
    formalClock.value = formal.clock ?? "";
    formalEdge.value = formal.edge === "negedge" ? "negedge" : "posedge";
    formalFiles.replaceChildren();
    for (const { path } of candidates) {
      const label = document.createElement("label");
      label.className = "simulation-file";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = path;
      input.checked = formal.files === null || formal.files.includes(path);
      input.disabled = formalRunning || buildRunning || libraryBusy;
      input.addEventListener("change", () => {
        project.formal.files = [
          ...formalFiles.querySelectorAll("input:checked"),
        ].map((element) => element.value);
        scheduleSave();
        renderFormalSettings();
      });
      label.append(input, document.createTextNode(path));
      formalFiles.append(label);
    }
    if (candidates.length === 0) {
      const message = document.createElement("p");
      message.textContent = "Verilog ファイルがありません。";
      formalFiles.append(message);
    }
    formalFilesNote.textContent = `対象は選択した ${formal.files?.length ?? candidates.length} 件の Verilog ファイルです。*_tb.v は既定で対象外です。`;
  }

  function updateFormalControls() {
    const paths = (project?.files ?? []).map(({ path }) => path);
    const hasVerilog = paths.some((path) => /\.(?:v|vh)$/i.test(path));
    const depth = Number(formalDepth.value);
    const timeout = Number(formalTimeout.value);
    const top = formalTop.value.trim();
    const solverReady = formalEngine.value !== "smtbmc" || Boolean(formalSolver.value);
    formalButton.textContent = formalRunning ? "停止" : "形式検証";
    formalReason.textContent = !hasVerilog
      ? "形式検証には Verilog ファイルを含むプロジェクトを開いてください。"
      : "";
    formalButton.disabled = libraryBusy || (formalRunning
      ? false
      : !hasVerilog || buildRunning || simulationRunning || !solverReady ||
        !Number.isInteger(depth) || depth < 1 || depth > 1000 ||
        !Number.isInteger(timeout) || timeout < 1 || timeout > 300 ||
        !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(top));
    const editing = formalRunning || buildRunning || simulationRunning || libraryBusy;
    formalEngine.disabled = editing;
    formalMode.disabled = editing;
    formalDepth.disabled = editing;
    formalTimeout.disabled = editing;
    formalTop.disabled = editing;
    formalClock.disabled = editing;
    formalEdge.disabled = editing;
    formalSolverField.hidden = formalEngine.value !== "smtbmc";
    formalSolver.disabled = editing || formalEngine.value !== "smtbmc";
    renderFormalSettings();
  }

  function persistFormalSettings() {
    if (!project?.formal) return;
    project.formal.engine = formalEngine.value;
    project.formal.solver = formalEngine.value === "smtbmc" ? formalSolver.value || null : null;
    project.formal.mode = formalMode.value;
    project.formal.depth = Number(formalDepth.value);
    project.formal.timeoutSeconds = Number(formalTimeout.value);
    project.formal.top = formalTop.value.trim();
    project.formal.clock = formalClock.value.trim() || null;
    project.formal.edge = formalEdge.value;
    scheduleSave();
  }

  function ensureSurferFrame() {
    if (surferFrame) return true;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2");
    context?.getExtension("WEBGL_lose_context")?.loseContext();
    if (!context) {
      waveformStatus.textContent =
        "この環境では WebGL が使えないため、波形を表示できません。選んだ VCD はダウンロードできます。";
      return false;
    }
    const frame = document.createElement("iframe");
    surferFrame = frame;
    frame.id = "surfer-frame";
    frame.title = "Surfer 波形ビューアー";
    frame.src = new URL("./surfer/index.html", import.meta.url).href;
    frame.addEventListener("load", () => {
      void (async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (surferFrame !== frame) return;
          if (
            typeof frame.contentWindow.register_message_listener === "function" &&
            typeof frame.contentWindow.inject_message === "function"
          ) {
            const script = frame.contentDocument.createElement("script");
            script.type = "module";
            script.src = new URL("./surfer-bridge.js", import.meta.url).href;
            frame.contentDocument.body.append(script);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (surferFrame === frame) resolveSurferBridge?.(false);
      })();
    }, { once: true });
    surferBridgePromise = new Promise((resolve) => {
      resolveSurferBridge = resolve;
    });
    surferMount.replaceChildren(frame);
    waveformStatus.textContent = currentVcd
      ? "波形を読み込んでいます。"
      : "シミュレーションを実行すると波形を表示します。";
    return true;
  }

  function resetSurferFrame() {
    resolveSurferBridge?.(false);
    surferFrame?.remove();
    surferFrame = null;
    surferBridgePromise = null;
    resolveSurferBridge = null;
  }

  function clearWaveforms() {
    waveformVersion += 1;
    resetSurferFrame();
    currentVcd = null;
    availableVcds = [];
    waveformFile.replaceChildren();
    waveformFileField.hidden = true;
    waveDownload.hidden = true;
    waveformStatus.textContent = "";
    if (vcdObjectUrl) URL.revokeObjectURL(vcdObjectUrl);
    vcdObjectUrl = null;
  }

  function setWaveforms(vcds, preferred) {
    availableVcds = vcds;
    waveformFile.replaceChildren();
    for (const { name } of vcds) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      waveformFile.append(option);
    }
    waveformFileField.hidden = vcds.length === 0;
    if (preferred) {
      waveformFile.value = preferred.name;
      void loadVcd(preferred);
    }
  }

  async function loadVcd(vcd) {
    const version = ++waveformVersion;
    if (currentVcd) resetSurferFrame();
    currentVcd = vcd;
    waveDownload.hidden = false;
    if (vcdObjectUrl) URL.revokeObjectURL(vcdObjectUrl);
    vcdObjectUrl = URL.createObjectURL(
      new Blob([vcd.bytes], { type: "text/plain" }),
    );
    waveDownloadLink.href = vcdObjectUrl;
    waveDownloadLink.download = vcd.name.split("/").at(-1);
    waveDownloadLink.textContent = `${vcd.name} を保存`;
    try {
      if (!ensureSurferFrame()) return;
      waveformStatus.textContent = "Surfer で波形を読み込んでいます。";
      const frame = surferFrame;
      const ready = await surferBridgePromise;
      if (version !== waveformVersion || frame !== surferFrame) return;
      if (!ready) {
        waveformStatus.textContent = "Surfer を読み込めません。";
        return;
      }
      frame.contentWindow.postMessage(
        { command: "LoadUrl", url: vcdObjectUrl },
        location.origin,
      );
    } catch {
      if (version === waveformVersion) {
        waveformStatus.textContent = "波形を読み込めません。VCD はダウンロードできます。";
      }
    }
  }

  async function runProjectSimulation() {
    if (libraryBusy) return;
    if (simulationRunning) {
      simRunner.stop();
      return;
    }
    if (!project || buildRunning || formalRunning || !canStartSimulation()) {
      simulationStatus.textContent = "ほかの処理が終わってから実行してください。";
      return;
    }
    const simulationProject = project;
    await flushPendingSave();
    if (project !== simulationProject || simulationRunning || buildRunning || formalRunning || !canStartSimulation()) return;
    const version = ++simulationVersion;
    clearWaveforms();
    simulationRunning = true;
    onSimulationStateChange(true);
    updateSynthesisControls();
    simulationStatus.dataset.outcome = "running";
    simulationStatus.textContent = "シミュレーションを実行しています。";
    programLog.textContent = "";
    const hasVhdl = project.files.some(({ path }) => /\.(?:vhd|vhdl)$/i.test(path));
    if (hasVhdl) appendProjectLog("VHDL ファイルはシミュレーションから除外しました。");
    renderProblems();
    try {
      const input = await prepareProjectInputs(simulationProject, fileContents, { simulation: true });
      if (version !== simulationVersion) return;
      const settings = input.project.simulation;
      const result = await simRunner.run({
        files: input.files,
        includeDirectories: input.includeDirectories,
        defines: input.defines,
        top: settings.top,
        timeLimitMs: settings.timeLimitSeconds * 1000,
      });
      if (version !== simulationVersion) return;
      if (result.stdout) appendProjectLog(result.stdout.trimEnd());
      if (result.stderr) appendProjectLog(result.stderr.trimEnd());
      const editorResults = editorDiagnostics(result.diagnostics);
      renderProblems(editorResults);
      window.dispatchEvent(
        new CustomEvent("toolchain:diagnostics", { detail: editorResults }),
      );
      simulationStatus.dataset.outcome = result.outcome;
      simulationStatus.textContent = {
        ok: "シミュレーションが完了しました。",
        failed: "シミュレーションに失敗しました。",
        timeout: "時間上限に達しました。",
        stopped: "シミュレーションを停止しました。",
      }[result.outcome];
      setWaveforms(result.vcds, result.vcd);
    } catch (error) {
      if (version !== simulationVersion) return;
      simulationStatus.dataset.outcome = "failed";
      simulationStatus.textContent = "シミュレーションに失敗しました。";
      appendProjectLog(`シミュレーションエラー: ${error.message}`);
    } finally {
      if (version === simulationVersion) {
        simulationRunning = false;
        onSimulationStateChange(false);
        updateSynthesisControls();
      }
    }
  }

  async function runProjectFormal() {
    if (libraryBusy) return;
    if (formalRunning) {
      formalRunner.stop();
      return;
    }
    if (!project || buildRunning || simulationRunning || formalRunning) {
      formalStatus.textContent = "ほかの処理が終わってから実行してください。";
      return;
    }
    const formalProject = project;
    await flushPendingSave();
    if (project !== formalProject || formalRunning || buildRunning || simulationRunning) return;
    const version = ++formalVersion;
    clearWaveforms();
    formalRunning = true;
    updateSynthesisControls();
    formalStatus.dataset.outcome = "running";
    formalStatus.textContent = "形式検証を実行しています。";
    programLog.textContent = "";
    renderProblems();
    try {
      const assets = await formalAssetLoader.loadAll();
      if (version !== formalVersion) return;
      const hash = await snapshotHash(formalProject, fileContents);
      if (version !== formalVersion) return;
      const outcome = await formalRunner.run({
        project: formalProject,
        files: fileContents,
        assets,
        snapshotHash: hash,
      });
      if (version !== formalVersion) return;
      const kindLabel = FORMAL_KIND_LABELS[outcome.kind] ?? outcome.kind;
      formalStatus.dataset.outcome =
        outcome.kind === "bounded-pass" || outcome.kind === "proved" || outcome.kind === "covered"
          ? "ok"
          : "failed";
      formalStatus.textContent = outcome.message ? `${kindLabel}（${outcome.message}）` : kindLabel;
      if (outcome.inventory?.counts) {
        const { assert, assume, cover } = outcome.inventory.counts;
        appendProjectLog(
          `形式検証の性質: assert ${assert} 件、assume ${assume} 件、cover ${cover} 件`,
        );
      }
      if (outcome.replay) {
        const replayLabel = { verified: "確認済み", rejected: "不一致", unavailable: "利用不可" }[outcome.replay.status]
          ?? outcome.replay.status;
        appendProjectLog(
          `反例の再実行: ${replayLabel}${outcome.replay.reason ? `（${outcome.replay.reason}）` : ""}`,
        );
      }
      if (outcome.vcd?.bytes?.length) {
        setWaveforms([outcome.vcd], outcome.vcd);
        updateTabs("waveform");
      }
    } catch (error) {
      if (version !== formalVersion) return;
      formalStatus.dataset.outcome = "failed";
      formalStatus.textContent = "形式検証に失敗しました。";
      appendProjectLog(`形式検証エラー: ${error.message}`);
    } finally {
      if (version === formalVersion) {
        formalRunning = false;
        updateSynthesisControls();
      }
    }
  }

  async function runProjectBuild() {
    if (libraryBusy || simulationRunning || formalRunning) return;
    if (buildRunning) {
      buildRunner.cancel();
      return;
    }
    if (!project) return;
    const buildProject = project;
    const version = ++buildVersion;
    buildRunning = true;
    onBuildStateChange(true);
    synthesisButton.textContent = "中止";
    synthesisStage.textContent = "合成";
    programButton.disabled = true;
    programLog.textContent = "";
    const diagnostics = [];
    const toolText = new Map();
    try {
      await flushPendingSave();
      if (version !== buildVersion || project !== buildProject) return;
      const input = await prepareProjectInputs(buildProject, fileContents);
      if (version !== buildVersion || project !== buildProject) return;
      const files = input.files;
      const result = await buildRunner.build(
        {
          board: input.project.board,
          top: input.project.top,
          vhdlStandard: input.project.vhdlStandard ?? "2008",
          files,
          includeDirectories: input.includeDirectories,
          defines: input.defines,
        },
        {
          onStage: (stage) => {
            const hasVhdl = files.some(({ path }) => /\.(?:vhd|vhdl)$/i.test(path));
            const labels = [
              ...(hasVhdl ? ["VHDL"] : []),
              "合成",
              "配置配線",
              "ビットストリーム",
            ];
            const indexes = hasVhdl
              ? { vhdl: 0, synth: 1, pnr: 2, pack: 3 }
              : { synth: 0, pnr: 1, pack: 2 };
            const activeIndex = indexes[stage];
            synthesisStage.textContent = labels
              .map((label, index) => index <= activeIndex ? label : "")
              .filter(Boolean)
              .join(" → ");
          },
          onLog: ({ tool, stream, text }) => {
            appendProjectLog(`[${tool} ${stream}] ${text}`);
            const prior = toolText.get(tool) ?? "";
            toolText.set(tool, prior + text);
          },
        },
      );
      if (version !== buildVersion || project !== buildProject) return;
      for (const [tool, text] of toolText) {
        diagnostics.push(...parseToolDiagnostics(tool, text));
      }
      const editorResults = editorDiagnostics(diagnostics);
      for (const file of result.files) {
        if (!project.files.some(({ path }) => path === file.path)) {
          project.files.push({ path: file.path });
        }
        fileContents.set(file.path, file.bytes);
      }
      await saveProject();
      renderFileList();
      renderFsSource(true, "build/top.fs");
      renderProblems(editorResults);
      window.dispatchEvent(
        new CustomEvent("toolchain:diagnostics", { detail: editorResults }),
      );
      window.dispatchEvent(
        new CustomEvent("toolchain:build-complete", {
          detail: {
            timings: result.timings,
            memoryBytes: result.memoryBytes,
          },
        }),
      );
      synthesisStage.textContent = "ビルド完了";
      appendProjectLog(
        `${result.timings.vhdl === undefined ? "" : `VHDL ${result.timings.vhdl.toFixed(0)} ms、`}` +
        `合成 ${result.timings.synth.toFixed(0)} ms、配置配線 ${result.timings.pnr.toFixed(0)} ms、ビットストリーム ${result.timings.pack.toFixed(0)} ms`,
      );
    } catch (error) {
      if (version !== buildVersion || project !== buildProject) return;
      if (error.name !== "AbortError") {
        for (const [tool, text] of toolText) {
          diagnostics.push(...parseToolDiagnostics(tool, text));
        }
        const failedTool = {
          vhdl: "ghdl",
          synth: "yosys",
          pnr: "nextpnr",
          pack: "gowin_pack",
        }[error.stage] ??
          (/^Yosys\b/i.test(error.message)
            ? "yosys"
            : /^nextpnr\b/i.test(error.message)
              ? "nextpnr"
              : null);
        if (failedTool) {
          const reported = parseToolDiagnostics(
            failedTool,
            `${[...toolText.values()].join("\n")}\n${error.message}`,
          );
          for (const diagnostic of reported) {
            if (
              !diagnostics.some(({ file, line, message }) =>
                file === diagnostic.file &&
                line === diagnostic.line &&
                message === diagnostic.message
              )
            ) {
              diagnostics.push(diagnostic);
            }
          }
        }
        const editorResults = editorDiagnostics(diagnostics);
        renderProblems(editorResults);
        window.dispatchEvent(
          new CustomEvent("toolchain:diagnostics", { detail: editorResults }),
        );
        appendProjectLog(`ビルドエラー: ${error.message}`);
        synthesisStage.textContent = "ビルド失敗";
      } else {
        synthesisStage.textContent = "中止しました";
      }
    } finally {
      if (version === buildVersion) {
        buildRunning = false;
        synthesisButton.textContent = "合成・配置配線";
        onBuildStateChange(libraryBusy);
        updateSynthesisControls();
      }
    }
  }

  async function refreshProjectSwitcher() {
    const names = await store.listProjects();
    projectSelect.replaceChildren();
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      projectSelect.append(option);
    }
    if (project) projectSelect.value = project.name;
  }

  function renderFsFileInfo() {
    if (!isBinaryPath(selectedPath)) {
      fsFileInfo.hidden = true;
      fsFileInfo.textContent = "";
      return;
    }
    const content = fileContents.get(selectedPath);
    const byteLength = typeof content === "string"
      ? new TextEncoder().encode(content).length
      : content?.byteLength ?? 0;
    fsFileInfo.hidden = false;
    fsFileInfo.textContent =
      `${selectedPath} は読み取り専用です。サイズ: ${byteLength} バイト。エディターでは開きません。`;
  }

  function saveUiState() {
    if (!project) return;
    try {
      localStorage.setItem(
        `${UI_STATE_PREFIX}${project.name}`,
        JSON.stringify({ openTabs, activeTab }),
      );
    } catch {
      setProjectStatus("タブの状態を保存できません。");
    }
  }

  function renderProblems(diagnostics = []) {
    problemList.replaceChildren();
    problemEmpty.hidden = diagnostics.length > 0;
    for (const diagnostic of diagnostics) {
      const item = document.createElement("li");
      const severity = {
        error: "エラー",
        warning: "警告",
        info: "情報",
        hint: "ヒント",
      }[diagnostic.severity] ?? "エラー";
      const location = diagnostic.file
        ? `${diagnostic.file}:${diagnostic.line}${diagnostic.column ? `:${diagnostic.column}` : ""}: `
        : "";
      item.textContent = `${severity}: ${location}${diagnostic.message}`;
      problemList.append(item);
    }
  }

  function editorDiagnostics(diagnostics) {
    return diagnostics.map((diagnostic) => {
      const path = diagnostic.file ?? activeTab;
      const lines = textForPath(path).split(/\r?\n/);
      const lineIndex = Number.isInteger(diagnostic.line)
        ? Math.min(Math.max(diagnostic.line - 1, 0), lines.length - 1)
        : 0;
      const lineStart = lines
        .slice(0, lineIndex)
        .reduce((length, line) => length + line.length + 1, 0);
      const columnOffset = Number.isInteger(diagnostic.column)
        ? Math.max(diagnostic.column - 1, 0)
        : 0;
      const from = path === activeTab
        ? lineStart + Math.min(columnOffset, lines[lineIndex].length)
        : 0;
      const to = path === activeTab ? lineStart + lines[lineIndex].length : from;
      return { ...diagnostic, from, to };
    });
  }

  function scheduleSave() {
    if (!project) return;
    clearTimeout(saveTimer);
    setProjectStatus("変更を保存しています。");
    saveTimer = setTimeout(() => {
      saveTimer = null;
      pendingSave = saveProject();
    }, 500);
  }

  async function saveProject() {
    if (!project) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    project.board = boardSelect.value;
    try {
      await store.save(project, fileContents);
      setProjectStatus("保存しました。");
    } catch (error) {
      setProjectStatus("プロジェクトを保存できません。");
      appendProjectLog(`プロジェクト保存エラー: ${error.message}`);
    }
  }

  async function flushPendingSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
      pendingSave = saveProject();
    }
    await pendingSave;
  }

  function textForPath(path) {
    return decodeContent(fileContents.get(path) ?? "");
  }

  function projectTexts() {
    return project.files
      .filter(({ path }) => !isBinaryPath(path))
      .map(({ path }) => textForPath(path));
  }

  function persistEditorContent(text) {
    if (libraryBusy || !activeTab || isLibraryPath(activeTab) || !fileContents.has(activeTab)) return;
    fileContents.set(activeTab, text);
    scheduleSave();
  }

  function updateEditor() {
    if (!editor) return;
    editor.setLanguage(activeTab ? languageForPath(activeTab) : "plain");
    editor.setReadOnly(libraryBusy || !activeTab || isLibraryPath(activeTab));
    editor.setText(activeTab ? textForPath(activeTab) : "");
    saveUiState();
  }

  function renderFileTabs() {
    fileTabs.replaceChildren();
    for (const path of openTabs) {
      const wrapper = document.createElement("div");
      wrapper.className = "editor-tab";
      const tab = document.createElement("button");
      tab.type = "button";
      tab.id = `editor-tab-${openTabs.indexOf(path)}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(path === activeTab));
      tab.setAttribute("aria-controls", "editor-mount");
      tab.setAttribute("aria-label", `${path} を編集`);
      tab.title = path;
      tab.textContent = path.split("/").at(-1);
      tab.addEventListener("click", () => {
        activeTab = path;
        selectedPath = path;
        renderFileList();
        renderFileTabs();
        updateEditor();
      });
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const index = openTabs.indexOf(path);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const nextPath = openTabs[(index + direction + openTabs.length) % openTabs.length];
        activeTab = nextPath;
        selectedPath = nextPath;
        renderFileList();
        renderFileTabs();
        updateEditor();
        [...fileTabs.querySelectorAll('[role="tab"]')]
          .find((candidate) => candidate.getAttribute("aria-label") === `${nextPath} を編集`)
          ?.focus();
      });
      const close = document.createElement("button");
      close.type = "button";
      close.className = "editor-tab-close";
      close.setAttribute("aria-label", `${path} のタブを閉じる`);
      close.textContent = "×";
      close.addEventListener("click", () => {
        const closedIndex = openTabs.indexOf(path);
        openTabs = openTabs.filter((openPath) => openPath !== path);
        if (activeTab === path) {
          activeTab = openTabs[Math.min(closedIndex, openTabs.length - 1)] ?? null;
        }
        renderFileTabs();
        updateEditor();
      });
      wrapper.append(tab, close);
      fileTabs.append(wrapper);
    }
  }

  function renderFileList() {
    fileList.replaceChildren();
    for (const { path } of project?.files ?? []) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "file-list-item";
      button.textContent = path;
      button.setAttribute("aria-label", `${path} を開く`);
      button.setAttribute("aria-pressed", String(path === selectedPath));
      button.addEventListener("click", () => {
        if (isBinaryPath(path)) {
          selectedPath = path;
          renderFileList();
          return;
        }
        openFile(path);
      });
      item.append(button);
      fileList.append(item);
    }
    const hasSelection = !libraryBusy && Boolean(selectedPath) && !isLibraryPath(selectedPath);
    renameFileButton.disabled = !hasSelection;
    deleteFileButton.disabled = !hasSelection;
    renderFsFileInfo();
  }

  function openFile(path) {
    selectedPath = path;
    if (!openTabs.includes(path)) openTabs = [...openTabs, path];
    activeTab = path;
    renderFileList();
    renderFileTabs();
    updateEditor();
  }

  function setPaneOpen(pane, button, open) {
    pane.dataset.open = String(open);
    button.setAttribute("aria-expanded", String(open));
    const paneName = pane === filesPane ? "ファイル一覧" : "ボードと書き込み";
    button.setAttribute("aria-label", `${paneName}を${open ? "閉じる" : "開く"}`);
  }

  function updateTabs(selectedTab) {
    editorPane.dataset.waveformActive = String(selectedTab === "waveform");
    ideLayout.classList.toggle("waveform-active", selectedTab === "waveform");
    for (const button of tabButtons) {
      const selected = button.dataset.bottomTab === selectedTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of tabPanels) {
      panel.hidden = panel.dataset.bottomPanel !== selectedTab;
    }
    if (selectedTab === "waveform") ensureSurferFrame();
  }

  function handleBottomTabKeydown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const selectedIndex = tabButtons.findIndex(
      (button) => button.dataset.bottomTab === event.currentTarget.dataset.bottomTab,
    );
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabButtons[
      (selectedIndex + direction + tabButtons.length) % tabButtons.length
    ];
    updateTabs(next.dataset.bottomTab);
    next.focus();
  }

  function showFileDialog(mode) {
    if (libraryBusy) return;
    if (mode === "rename" && isLibraryPath(selectedPath)) return;
    fileDialogMode = mode;
    const renaming = mode === "rename";
    fileDialogHeading.textContent = renaming ? "ファイル名を変更" : "ファイルを追加";
    filePathInput.value = renaming ? selectedPath ?? "" : "";
    fileContentInput.value = "";
    fileUploadField.hidden = mode !== "add";
    filePathError.textContent = "";
    filePathSaveButton.textContent = renaming ? "名前を変更" : "追加する";
    fileDialog.showModal();
    filePathInput.focus();
  }

  async function submitFileDialog() {
    if (libraryBusy) return;
    const path = filePathInput.value.trim();
    const validation = validatePath(path);
    if (isLibraryPath(path) || (fileDialogMode === "rename" && isLibraryPath(selectedPath))) {
      filePathError.textContent = "ライブラリーの専用領域は直接変更できません。";
      return;
    }
    if (!validation.ok) {
      filePathError.textContent = validation.errors[0];
      filePathInput.setAttribute("aria-invalid", "true");
      return;
    }
    filePathInput.removeAttribute("aria-invalid");

    if (fileDialogMode === "add") {
      if (project.files.some((file) => file.path === path)) {
        filePathError.textContent = "同じパスのファイルがすでにあります。";
        return;
      }
      const upload = fileContentInput.files[0];
      let content = templateForPath(path);
      if (isBinaryPath(path)) {
        const extension = path.slice(path.lastIndexOf("."));
        if (!upload || !upload.name.toLowerCase().endsWith(extension)) {
          filePathError.textContent = `${extension} ファイルを選んでください。`;
          return;
        }
        content = new Uint8Array(await upload.arrayBuffer());
      } else if (upload) {
        filePathError.textContent = "アップロードできるのは .fs と .bin ファイルだけです。";
        return;
      }
      project.files.push({ path });
      fileContents.set(path, content);
      selectedPath = path;
      if (!isBinaryPath(path)) {
        openTabs = [...openTabs, path];
        activeTab = path;
      }
    } else {
      const oldPath = selectedPath;
      if (!oldPath || oldPath === path) {
        fileDialog.close();
        return;
      }
      if (project.files.some((file) => file.path === path)) {
        filePathError.textContent = "同じパスのファイルがすでにあります。";
        return;
      }
      project.files = project.files.map((file) =>
        file.path === oldPath ? { path } : file,
      );
      if (Array.isArray(project.simulation?.files)) {
        project.simulation.files = project.simulation.files.map((selected) =>
          selected === oldPath ? path : selected,
        );
      }
      fileContents.set(path, fileContents.get(oldPath));
      fileContents.delete(oldPath);
      openTabs = openTabs.map((openPath) => (openPath === oldPath ? path : openPath));
      if (activeTab === oldPath) activeTab = path;
      selectedPath = path;
    }

    fileDialog.close();
    renderFileList();
    renderFileTabs();
    updateEditor();
    updateSynthesisControls();
    renderFsSource(true);
    await refreshProjectSwitcher();
    scheduleSave();
  }

  function deleteSelectedFile() {
    if (libraryBusy || !selectedPath || isLibraryPath(selectedPath)) return;
    const path = selectedPath;
    if (!window.confirm(`「${path}」を削除しますか。`)) return;
    project.files = project.files.filter((file) => file.path !== path);
    if (Array.isArray(project.simulation?.files)) {
      project.simulation.files = project.simulation.files.filter(
        (selected) => selected !== path,
      );
    }
    fileContents.delete(path);
    openTabs = openTabs.filter((openPath) => openPath !== path);
    if (activeTab === path) activeTab = openTabs.at(-1) ?? null;
    selectedPath = null;
    renderFileList();
    renderFileTabs();
    updateEditor();
    updateSynthesisControls();
    renderFsSource(true);
    void refreshProjectSwitcher();
    scheduleSave();
  }

  function renderBoardOptions() {
    for (const board of boardSelect.options) {
      const boardData = BOARDS.find(({ id }) => id === board.value);
      if (boardData) board.dataset.board = JSON.stringify(boardData);
    }
    for (const board of BOARDS) {
      const option = document.createElement("option");
      option.value = board.id;
      option.textContent = board.label;
      newProjectBoardSelect.append(option);
    }
  }

  function activateProject(loaded) {
    buildVersion += 1;
    buildRunner.cancel();
    buildRunning = false;
    onBuildStateChange(libraryBusy);
    synthesisButton.textContent = "合成・配置配線";
    simulationVersion += 1;
    simRunner.stop();
    simulationRunning = false;
    onSimulationStateChange(false);
    formalVersion += 1;
    formalRunner.stop();
    formalRunning = false;
    clearWaveforms();
    simulationStatus.textContent = "";
    simulationStatus.dataset.outcome = "";
    formalStatus.textContent = "";
    formalStatus.dataset.outcome = "";
    project = loaded.project;
    project.vhdlStandard ??= "2008";
    fileContents = loaded.files;
    projectName.textContent = project.name;
    boardSelect.value = project.board;
    const savedState = readUiState(project.name, project);
    openTabs = savedState.openTabs;
    activeTab = savedState.activeTab;
    if (!activeTab) {
      const firstTextFile = project.files.find(({ path }) => !isBinaryPath(path));
      if (firstTextFile) {
        openTabs = [firstTextFile.path];
        activeTab = firstTextFile.path;
      }
    }
    selectedPath = activeTab ?? project.files[0]?.path ?? null;
    renderFileList();
    renderFileTabs();
    if (!editor) {
      editor = createHdlEditor(editorMount, {
        doc: activeTab ? textForPath(activeTab) : "",
        language: activeTab ? languageForPath(activeTab) : "plain",
        readOnly: libraryBusy || !activeTab || isLibraryPath(activeTab),
        onChange: persistEditorContent,
        onDiagnostics: renderProblems,
        getProjectTexts: projectTexts,
      });
    } else {
      updateEditor();
    }
    updateBoardInformation();
    updateSynthesisControls();
    renderFsSource(true);
    void refreshProjectSwitcher();
    boardSelect.dispatchEvent(new Event("change", { bubbles: true }));
    setProjectStatus("保存しました。");
    void librarySelector.refresh();
  }

  async function openProject(name) {
    saveUiState();
    await flushPendingSave();
    activateProject(await store.load(name));
  }

  async function initializeProject() {
    try {
      const names = await store.listProjects();
      if (names.length > 0) {
        activateProject(await store.load(names[0]));
      } else {
        const initial = createBlinkTemplate(boardSelect.value, "verilog");
        await store.save(initial.project, initial.files);
        activateProject(initial);
      }
    } catch (error) {
      setProjectStatus("プロジェクトを読み込めません。");
      appendProjectLog(`プロジェクト読み込みエラー: ${error.message}`);
    }
  }

  async function createProject() {
    const name = newProjectNameInput.value;
    const validation = validateProjectName(name);
    if (!validation.ok) {
      newProjectError.textContent = validation.errors[0];
      return;
    }
    try {
      const names = await store.listProjects();
      if (names.includes(name)) {
        newProjectError.textContent = "同じ名前のプロジェクトがすでにあります。";
        return;
      }
      await flushPendingSave();
      const created = createBlinkTemplate(
        newProjectBoardSelect.value,
        newProjectLanguageSelect.value,
      );
      created.project.name = name;
      created.project.vhdlStandard =
        newProjectLanguageSelect.value === "vhdl"
          ? newProjectStandardSelect.value
          : "2008";
      await store.save(created.project, created.files);
      newProjectDialog.close();
      newProjectNameInput.value = "";
      newProjectError.textContent = "";
      setProjectActionStatus("");
      activateProject(created);
    } catch (error) {
      newProjectError.textContent = error.message;
    }
  }

  async function exportCurrentProject() {
    if (!project) return;
    try {
      const bytes = await exportProjectZip(project, fileContents);
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${project.name}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProjectActionStatus("ZIP ファイルを書き出しました。");
    } catch (error) {
      setProjectActionStatus(error.message);
    }
  }

  async function importProjectFile() {
    const file = projectZipInput.files[0];
    if (!file) return;
    try {
      const imported = await importProjectZip(
        new Uint8Array(await file.arrayBuffer()),
      );
      const names = await store.listProjects();
      if (names.includes(imported.project.name)) {
        setProjectActionStatus("同じ名前のプロジェクトがすでにあります。");
        return;
      }
      await flushPendingSave();
      await store.save(imported.project, imported.files);
      projectZipInput.value = "";
      activateProject(imported);
      setProjectActionStatus("ZIP ファイルを読み込みました。");
    } catch (error) {
      setProjectActionStatus(error.message);
    }
  }

  renderBoardOptions();
  updateBoardInformation();
  updateTabs("log");
  renderProblems();
  addFileButton.addEventListener("click", () => showFileDialog("add"));
  renameFileButton.addEventListener("click", () => showFileDialog("rename"));
  deleteFileButton.addEventListener("click", deleteSelectedFile);
  filePathSaveButton.addEventListener("click", () => {
    void submitFileDialog();
  });
  filePathCancelButton.addEventListener("click", () => fileDialog.close());
  fileContentInput.addEventListener("change", () => {
    const upload = fileContentInput.files[0];
    if (upload && filePathInput.value.trim() === "") {
      filePathInput.value = upload.name;
    }
  });
  filePathInput.addEventListener("input", () => {
    filePathError.textContent = "";
    filePathInput.removeAttribute("aria-invalid");
  });
  filePathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void submitFileDialog();
    }
  });
  projectSelect.addEventListener("change", () => {
    if (!project || projectSelect.value === project.name) return;
    void withWorkspaceChange(() => openProject(projectSelect.value)).catch((error) => {
      setProjectActionStatus(`プロジェクトを切り替えられません: ${error.message}`);
      void refreshProjectSwitcher();
    });
  });
  newProjectButton.addEventListener("click", () => {
    newProjectError.textContent = "";
    newProjectBoardSelect.value = boardSelect.value;
    newProjectStandardField.hidden = newProjectLanguageSelect.value !== "vhdl";
    newProjectDialog.showModal();
    newProjectNameInput.focus();
  });
  newProjectLanguageSelect.addEventListener("change", () => {
    newProjectStandardField.hidden = newProjectLanguageSelect.value !== "vhdl";
  });
  vhdlStandardSelect.addEventListener("change", () => {
    if (!project) return;
    project.vhdlStandard = vhdlStandardSelect.value;
    scheduleSave();
  });
  newProjectCreateButton.addEventListener("click", () => {
    void withWorkspaceChange(createProject);
  });
  newProjectCancelButton.addEventListener("click", () => newProjectDialog.close());
  exportProjectButton.addEventListener("click", () => {
    void withWorkspaceChange(exportCurrentProject);
  });
  importProjectButton.addEventListener("click", () => projectZipInput.click());
  projectZipInput.addEventListener("change", () => {
    if (libraryBusy) {
      projectZipInput.value = "";
      return;
    }
    void withWorkspaceChange(importProjectFile);
  });
  fsSource.addEventListener("change", () => {
    const selected = fsSource.value;
    localFsField.hidden = selected !== "local";
    if (selected === "local") {
      onFsSourceChange(null);
    } else {
      const content = fileContents.get(selected);
      const bytes = content instanceof Uint8Array
        ? new Uint8Array(content)
        : new TextEncoder().encode(content ?? "");
      onFsSourceChange({
        name: selected.split("/").at(-1),
        bytes,
      });
    }
  });
  boardSelect.addEventListener("change", () => {
    if (project) project.board = boardSelect.value;
    updateBoardInformation();
    scheduleSave();
    void librarySelector.refresh();
  });
  form.addEventListener("change", updateBoardInformation);
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => updateTabs(button.dataset.bottomTab));
    button.addEventListener("keydown", handleBottomTabKeydown);
  });
  window.addEventListener("message", (event) => {
    if (
      !surferFrame ||
      event.origin !== location.origin ||
      event.source !== surferFrame.contentWindow
    ) return;
    if (event.data?.type === "toolchain:surfer-bridge-ready") {
      resolveSurferBridge?.(true);
    } else if (event.data?.type === "toolchain:surfer-waveform-loaded") {
      const inject = surferFrame.contentWindow.inject_message;
      if (typeof inject === "function") {
        const scopes = vcdRootScopes(currentVcd.bytes).map((name) => [name]);
        for (const strs of scopes.length > 0 ? scopes : [[]]) {
          inject(JSON.stringify({ AddScope: [{ strs, id: "None" }, true] }));
        }
        waveformStatus.textContent = "波形を表示しています。";
      }
    } else if (event.data?.type === "toolchain:surfer-waveform-timeout") {
      waveformStatus.textContent = "波形の読み込みがタイムアウトしました。";
    }
  });
  simulationButton.addEventListener("click", () => void runProjectSimulation());
  formalButton.addEventListener("click", () => void runProjectFormal());
  for (const control of [formalEngine, formalSolver, formalMode]) {
    control.addEventListener("change", () => {
      persistFormalSettings();
      updateFormalControls();
    });
  }
  for (const control of [formalDepth, formalTimeout, formalTop, formalClock, formalEdge]) {
    control.addEventListener("change", () => {
      persistFormalSettings();
      updateFormalControls();
    });
  }
  waveformFile.addEventListener("change", () => {
    const vcd = availableVcds.find(({ name }) => name === waveformFile.value);
    if (vcd) void loadVcd(vcd);
  });
  simulationTop.addEventListener("input", () => {
    if (!project) return;
    project.simulation.top = simulationTop.value;
    scheduleSave();
    updateSimulationControls();
  });
  simulationTimeLimit.addEventListener("change", () => {
    if (!project) return;
    const value = Number(simulationTimeLimit.value);
    if (Number.isInteger(value) && value >= 1 && value <= 120) {
      project.simulation.timeLimitSeconds = value;
      scheduleSave();
    }
    updateSimulationControls();
  });
  window.addEventListener("pagehide", () => {
    simRunner.dispose();
    formalRunner.dispose();
    if (vcdObjectUrl) URL.revokeObjectURL(vcdObjectUrl);
  }, { once: true });
  toggleFilesButton.addEventListener("click", () => {
    const open = filesPane.dataset.open !== "true";
    setPaneOpen(filesPane, toggleFilesButton, open);
    if (open) setPaneOpen(boardPane, toggleBoardButton, false);
  });
  toggleBoardButton.addEventListener("click", () => {
    const open = boardPane.dataset.open !== "true";
    setPaneOpen(boardPane, toggleBoardButton, open);
    if (open) setPaneOpen(filesPane, toggleFilesButton, false);
  });
  closeFilesPaneButton.addEventListener("click", () =>
    setPaneOpen(filesPane, toggleFilesButton, false),
  );
  closeBoardPaneButton.addEventListener("click", () =>
    setPaneOpen(boardPane, toggleBoardButton, false),
  );
  window.addEventListener("toolchain:diagnostics", (event) => {
    editor?.setDiagnostics(event.detail);
  });
  document.addEventListener("toolchain:artifacts-ready", () => {
    updateTabs("artifacts");
  });
  document.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void saveProject();
    }
  });

  renderFsSource(true);
  synthesisButton.addEventListener("click", () => void runProjectBuild());
  boardSelect.addEventListener("change", updateSynthesisControls);
  void initializeProject();
}
