import { BOARDS, getBoard } from "./lib/boards.mjs";
import { buildArgs } from "./lib/build-args.mjs";
import { classifyResult } from "./lib/classify-result.mjs";
import {
  FS_IDCODE_MASK,
  fsIdcode,
  fsIdcodeMatchesBoard,
} from "./lib/fs-idcode.mjs";
import {
  defaultOptions,
  getApplicability,
  validateOptions,
} from "./lib/options.mjs";
import { parseProgress } from "./lib/parse-progress.mjs";
import { writeTerminalText } from "./lib/terminal-output.mjs";
import { initializeIde } from "./ide.mjs";

const form = document.querySelector("#program-form");
const boardSelect = document.querySelector("#board-select");
const fileInput = document.querySelector("#bitstream-file");
const fsSourceSelect = document.querySelector("#fs-source");
const targetOptions = document.querySelector("#target-options");
const flashWriteWarning = document.querySelector("#flash-write-warning");
const flashEraseWarning = document.querySelector("#flash-erase-warning");
const dumpOperationHint = document.querySelector("#dump-operation-hint");
const eraseOperationHint = document.querySelector("#erase-operation-hint");
const flashTypeOptions = document.querySelector("#flash-type-options");
const verifyOption = document.querySelector("#verify-option");
const offsetOption = document.querySelector("#offset-option");
const offsetResetButton = document.querySelector("#offset-reset");
const unprotectOption = document.querySelector("#unprotect-option");
const frequencyOption = document.querySelector("#frequency-option");
const resetOption = document.querySelector("#reset-option");
const verbosityOption = document.querySelector("#verbosity-option");
const mcufwFileInput = document.querySelector("#mcufw-file");
const userFlashFileInput = document.querySelector("#user-flash-file");
const protectOption = document.querySelector("#protect-option");
const dumpSizeInput = document.querySelector("#dump-size-bytes");
const dumpSizeOptions = document.querySelector("#dump-size-options");
const programButton = document.querySelector("#program-button");
const supportStatus = document.querySelector("#support-status");
const commandPreview = document.querySelector("#command-preview");
const validationErrors = document.querySelector("#validation-errors");
const runPanel = document.querySelector("#run-panel");
const runHeading = document.querySelector("#run-heading");
const resultStatus = document.querySelector("#result-status");
const downloadResult = document.querySelector("#download-result");
const dumpDownload = document.querySelector("#dump-download");
const progressBar = document.querySelector("#progress-bar");
const programLog = document.querySelector("#program-log");
const idcodeDialog = document.querySelector("#idcode-dialog");
const idcodeWarning = document.querySelector("#idcode-warning");
const idcodeCancelButton = document.querySelector("#idcode-cancel");
const idcodeContinueButton = document.querySelector("#idcode-continue");
const eraseDialog = document.querySelector("#erase-dialog");
const eraseWarning = document.querySelector("#erase-warning");
const eraseCancelButton = document.querySelector("#erase-cancel");
const eraseConfirmButton = document.querySelector("#erase-confirm");

let supportAvailable = false;
let activeWorker = null;
let selectedFileIdcode = null;
let fileIdcodeReady = true;
let synthesisBuildRunning = false;
let fileReadVersion = 0;
let verifySelection = defaultOptions().verify;
let terminalState = { text: "" };
let downloadUrl = null;
let projectFsSource = null;

for (const board of BOARDS) {
  const option = document.createElement("option");
  option.value = board.id;
  option.textContent = `${board.label} (${board.part})`;
  boardSelect.append(option);
}

function checkBrowserSupport() {
  const missing = [];
  if (typeof navigator.usb?.requestDevice !== "function") {
    missing.push("WebUSB");
  }
  if (!globalThis.crossOriginIsolated) {
    missing.push("Cross-Origin Isolation");
  }
  if (
    typeof WebAssembly.Suspending !== "function" ||
    typeof WebAssembly.promising !== "function"
  ) {
    missing.push("WebAssembly JSPI");
  }
  return missing;
}

function selected(name) {
  return form.elements[name].value;
}

function selectRadio(name, value) {
  for (const input of form.querySelectorAll(`input[name="${name}"]`)) {
    input.checked = input.value === value;
  }
}

function readOptions() {
  return {
    operation: selected("operation"),
    target: selected("target"),
    flashType: selected("flash-type"),
    verify: verifySelection,
    offset: offsetOption.value,
    unprotectFlash: unprotectOption.checked,
    frequency: frequencyOption.value,
    reset: resetOption.checked,
    verbosity: verbosityOption.value,
    mcufw: mcufwFileInput.files.length > 0,
    userFlash: userFlashFileInput.files.length > 0,
    protectFlash: protectOption.checked,
    dumpSize: selected("dump-size"),
    dumpSizeBytes: dumpSizeInput.value,
  };
}

function setReason(id, applicability) {
  const element = document.querySelector(`#${id}`);
  element.textContent = applicability.enabled ? "" : applicability.reason;
}

function formatCommand(args) {
  return ["openFPGALoader", ...args]
    .map((argument) => (/\s/.test(argument) ? JSON.stringify(argument) : argument))
    .join(" ");
}

function formatIdcode(idcode) {
  return `0x${(idcode >>> 0).toString(16).padStart(8, "0")}`;
}

function fileSizes() {
  const source = selectedFsSource();
  return {
    fs: source?.bytes?.byteLength ?? source?.file?.size,
    mcufw: mcufwFileInput.files[0]?.size,
    userFlash: userFlashFileInput.files[0]?.size,
  };
}

function selectedFsSource() {
  if (fsSourceSelect.value !== "local") {
    return projectFsSource;
  }
  const file = fileInput.files[0];
  return file ? { name: file.name, file } : null;
}

function updateForm() {
  const board = getBoard(boardSelect.value);
  if (!board) return;

  let options = readOptions();
  if (options.operation === "dump" || options.operation === "erase") {
    selectRadio("flash-type", "external");
  } else if (options.target !== "flash" || board.id === "tangnano1k") {
    selectRadio("flash-type", "internal");
  } else if (board.id === "tangnano20k") {
    selectRadio("flash-type", "external");
  }
  if (options.operation !== "dump" && options.dumpSize !== "all") {
    selectRadio("dump-size", "all");
  }
  options = readOptions();

  flashWriteWarning.hidden =
    options.operation !== "write" || options.target !== "flash";
  flashEraseWarning.hidden = options.operation !== "erase";
  dumpOperationHint.hidden = options.operation !== "dump";
  eraseOperationHint.hidden = options.operation !== "erase";

  let applicability = getApplicability(board.id, options);
  if (!applicability.verify.enabled && verifySelection !== "default") {
    verifySelection = "default";
    options = readOptions();
    applicability = getApplicability(board.id, options);
  }

  const operationInputs = form.querySelectorAll('input[name="operation"]');
  operationInputs.forEach((input) => {
    input.disabled = !applicability.operation[input.value].enabled;
  });
  targetOptions.disabled = options.operation !== "write";
  targetOptions.querySelectorAll("input").forEach((input) => {
    input.disabled = options.operation !== "write";
  });
  fsSourceSelect.disabled = options.operation !== "write";
  const localSource = fsSourceSelect.value === "local";
  fileInput.disabled = options.operation !== "write" || !localSource;
  fileInput.required = options.operation === "write" && localSource;

  flashTypeOptions.hidden =
    options.operation === "write" && options.target !== "flash";
  form.querySelector('input[name="flash-type"][value="internal"]').disabled =
    !applicability.internalFlash.enabled;
  form.querySelector('input[name="flash-type"][value="external"]').disabled =
    !applicability.externalFlash.enabled;

  verifyOption.disabled = !applicability.verify.enabled;
  verifyOption.checked = verifySelection === "default"
    ? applicability.verify.enabled
    : verifySelection;
  offsetOption.disabled = !applicability.offset.enabled;
  offsetResetButton.hidden =
    applicability.offset.enabled || Number(offsetOption.value) === 0;
  unprotectOption.disabled = !applicability.unprotectFlash.enabled;
  resetOption.disabled = !applicability.reset.enabled;
  mcufwFileInput.disabled = !applicability.mcufw.enabled;
  userFlashFileInput.disabled = !applicability.userFlash.enabled;
  protectOption.disabled = true;
  dumpSizeOptions.disabled = !applicability.dumpSize.enabled;
  dumpSizeInput.disabled =
    !applicability.dumpSize.enabled || options.dumpSize !== "custom";

  setReason("dump-operation-reason", applicability.operation.dump);
  setReason("erase-operation-reason", applicability.operation.erase);
  setReason("internal-flash-reason", applicability.internalFlash);
  setReason("external-flash-reason", applicability.externalFlash);
  setReason("verify-reason", applicability.verify);
  setReason("offset-reason", applicability.offset);
  setReason("unprotect-reason", applicability.unprotectFlash);
  setReason("reset-reason", applicability.reset);
  setReason("mcufw-reason", applicability.mcufw);
  setReason("user-flash-reason", applicability.userFlash);
  setReason("protect-reason", applicability.protectFlash);
  setReason("dump-size-reason", applicability.dumpSize);

  const errors = validateOptions(board.id, options, { fileSizes: fileSizes() });
  validationErrors.replaceChildren();
  for (const error of errors) {
    const item = document.createElement("li");
    item.textContent = error;
    validationErrors.append(item);
  }
  validationErrors.hidden = errors.length === 0;

  try {
    commandPreview.textContent = formatCommand(buildArgs({
      board: board.id,
      options,
    }));
  } catch {
    commandPreview.textContent = "設定を確認してください。";
  }

  programButton.textContent = options.operation === "dump"
    ? "読み出す"
    : options.operation === "erase"
      ? "消去する"
      : "書き込む";
  programButton.disabled =
    !supportAvailable ||
    synthesisBuildRunning ||
    activeWorker !== null ||
    !fileIdcodeReady ||
    errors.length > 0;
}

function setResult(text, succeeded = false) {
  resultStatus.textContent = text;
  resultStatus.dataset.result = succeeded ? "success" : "failure";
}

function requestDeviceResult() {
  try {
    return navigator.usb
      .requestDevice({
        filters: [{ vendorId: 0x0403, productId: 0x6010 }],
      })
      .then(
        (device) => ({ device }),
        (error) => ({ error }),
      );
  } catch (error) {
    return Promise.resolve({ error });
  }
}

function confirmIdcodeMismatch(board, fileIdcode) {
  const boardIdcode = board.idcode & FS_IDCODE_MASK;
  const maskedFileIdcode = fileIdcode & FS_IDCODE_MASK;
  const rawValue =
    fileIdcode === maskedFileIdcode
      ? ""
      : `（生の値 ${formatIdcode(fileIdcode)}）`;
  idcodeWarning.textContent =
    `${board.label} の IDCODE ${formatIdcode(boardIdcode)} と、` +
    `ファイルの IDCODE ${formatIdcode(maskedFileIdcode)}${rawValue}は一致しません。`;
  idcodeDialog.returnValue = "cancel";
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve(result);
    };

    idcodeDialog.addEventListener(
      "close",
      () => finish({ confirmed: false }),
      { once: true, signal: controller.signal },
    );
    idcodeCancelButton.addEventListener(
      "click",
      () => idcodeDialog.close("cancel"),
      { once: true, signal: controller.signal },
    );
    idcodeContinueButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        const deviceResult = requestDeviceResult();
        idcodeDialog.close("continue");
        finish({ confirmed: true, deviceResult });
      },
      { once: true, signal: controller.signal },
    );
    idcodeDialog.showModal();
  });
}

function confirmErase(board) {
  eraseWarning.textContent =
    `${board.label} を消去します。フラッシュの内容がすべて消えます。`;
  eraseDialog.returnValue = "cancel";
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      controller.abort();
      resolve(result);
    };

    eraseDialog.addEventListener(
      "close",
      () => finish({ confirmed: false }),
      { once: true, signal: controller.signal },
    );
    eraseCancelButton.addEventListener(
      "click",
      () => eraseDialog.close("cancel"),
      { once: true, signal: controller.signal },
    );
    eraseConfirmButton.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        const deviceResult = requestDeviceResult();
        eraseDialog.close("confirm");
        finish({ confirmed: true, deviceResult });
      },
      { once: true, signal: controller.signal },
    );
    eraseDialog.showModal();
    eraseCancelButton.focus();
  });
}

async function readSelectedFileIdcode() {
  const source = selectedFsSource();
  const version = ++fileReadVersion;
  selectedFileIdcode = null;
  fileIdcodeReady = !source || selected("operation") !== "write";
  updateForm();
  if (!source || selected("operation") !== "write") {
    return;
  }

  fileIdcodeReady = false;
  updateForm();
  try {
    const bytes = source.bytes ?? new Uint8Array(await source.file.arrayBuffer());
    const idcode = fsIdcode(new TextDecoder().decode(bytes));
    if (version === fileReadVersion) {
      selectedFileIdcode = idcode;
    }
  } catch {
    if (version === fileReadVersion) {
      selectedFileIdcode = null;
    }
  } finally {
    if (version === fileReadVersion) {
      fileIdcodeReady = true;
      updateForm();
    }
  }
}

function showRunPanel(operation) {
  terminalState = { text: "" };
  runPanel.hidden = false;
  runHeading.textContent = operation === "dump"
    ? "読み出し結果"
    : operation === "erase"
      ? "消去結果"
      : "書き込み結果";
  programLog.textContent = "";
  progressBar.value = 0;
  downloadResult.hidden = true;
  if (downloadUrl) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
}

function appendOutput(stream, chunk) {
  const progress = parseProgress(chunk);
  if (progress !== null) {
    progressBar.value = progress;
  }
  const text = String(chunk).replace(/\x1b\[[0-9;]*m/g, "");
  const prefix = stream === "stderr" ? "[stderr] " : "";
  const lineBreak = progress === null && !text.endsWith("\n") ? "\n" : "";
  terminalState = writeTerminalText(terminalState, `${prefix}${text}${lineBreak}`);
  programLog.textContent = terminalState.text;
}

function parseBytes(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) return null;
  const number = Number(text.startsWith("0x") || text.startsWith("0X")
    ? BigInt(text)
    : text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function finishRun(
  worker,
  { exitCode, timedOut = false, error = "", outputs = [] },
) {
  if (activeWorker !== worker) return;
  clearTimeout(worker.runTimeout);
  worker.terminate();
  activeWorker = null;
  if (error) appendOutput("stderr", error);

  const context = worker.runContext;
  let result = classifyResult({
    exitCode,
    log: programLog.textContent,
    timedOut,
    operation: context.options.operation,
  });
  if (result.ok && context.options.operation === "dump") {
    const dump = outputs.find((output) => output.path === "/dump.bin");
    const bytes = dump?.bytes instanceof Uint8Array
      ? dump.bytes
      : new Uint8Array(dump?.bytes ?? []);
    if (!dump || bytes.length !== context.dumpSize) {
      result = { ok: false, reason: "読み出したデータの長さが一致しません。" };
    } else {
      const blob = new Blob([bytes], { type: "application/octet-stream" });
      downloadUrl = URL.createObjectURL(blob);
      dumpDownload.href = downloadUrl;
      dumpDownload.download =
        `${context.board.id}-flash-0x${context.offset.toString(16)}-${context.dumpSize}.bin`;
      downloadResult.hidden = false;
      document.dispatchEvent(new CustomEvent("toolchain:artifacts-ready"));
    }
  }

  setResult(result.ok ? "成功" : `失敗：${result.reason}`, result.ok);
  if (result.ok) progressBar.value = 100;
  updateForm();
}

async function startRun(board, options, file, fileIdcode) {
  let deviceResultPromise;
  if (options.operation === "erase") {
    const confirmation = await confirmErase(board);
    if (!confirmation.confirmed) return;
    deviceResultPromise = confirmation.deviceResult;
  } else if (
    options.operation === "write" &&
    fileIdcode !== null &&
    !fsIdcodeMatchesBoard(fileIdcode, board)
  ) {
    const confirmation = await confirmIdcodeMismatch(board, fileIdcode);
    if (!confirmation.confirmed) return;
    deviceResultPromise = confirmation.deviceResult;
  } else {
    deviceResultPromise = requestDeviceResult();
  }

  const deviceResult = await deviceResultPromise;
  if (deviceResult.error) {
    showRunPanel(options.operation);
    const message = deviceResult.error.name === "NotFoundError"
      ? "失敗：デバイスなし"
      : `失敗：デバイス選択エラー（${deviceResult.error}）`;
    setResult(message);
    return;
  }

  const args = buildArgs({ board: board.id, options });
  const files = [];
  if (options.operation === "write") {
    const inputBytes = file.bytes ?? new Uint8Array(await file.file.arrayBuffer());
    files.push({
      path: "/input.fs",
      bytes: inputBytes,
    });
    if (options.mcufw) {
      files.push({
        path: "/mcufw.bin",
        bytes: new Uint8Array(await mcufwFileInput.files[0].arrayBuffer()),
      });
    }
    if (options.userFlash) {
      files.push({
        path: "/user-flash.bin",
        bytes: new Uint8Array(await userFlashFileInput.files[0].arrayBuffer()),
      });
    }
  }

  const dumpSize = options.operation === "dump"
    ? options.dumpSize === "all"
      ? board.flashBytes
      : parseBytes(options.dumpSizeBytes)
    : 0;
  const offset = parseBytes(options.offset) ?? 0;
  showRunPanel(options.operation);
  resultStatus.textContent = options.operation === "dump"
    ? "読み出し中です。"
    : options.operation === "erase"
      ? "消去中です。"
      : "書き込み中です。";

  const worker = new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
  });
  activeWorker = worker;
  worker.runContext = { board, options, dumpSize, offset };
  updateForm();

  worker.onmessage = ({ data }) => {
    if (data.type === "log") {
      appendOutput(data.stream, data.text);
    } else if (data.type === "done") {
      finishRun(worker, { exitCode: data.exitCode, outputs: data.outputs ?? [] });
    } else if (data.type === "error") {
      finishRun(worker, {
        exitCode: data.exitCode ?? 1,
        error: data.message,
      });
    }
  };

  worker.onerror = (event) => {
    event.preventDefault();
    finishRun(worker, { exitCode: 1, error: event.message });
  };

  const timeoutMs =
    options.operation === "write" && options.target === "sram"
      ? 120_000
      : 900_000;
  worker.runTimeout = setTimeout(() => {
    finishRun(worker, { exitCode: 1, timedOut: true });
  }, timeoutMs);
  worker.postMessage({
    args,
    files,
    outputs: options.operation === "dump" ? ["/dump.bin"] : [],
  });
}

function initialize() {
  const missing = checkBrowserSupport();
  supportAvailable = missing.length === 0;
  supportStatus.textContent = supportAvailable
    ? "このブラウザーを利用できます。"
    : `このブラウザーでは操作できません。足りない機能：${missing.join("、")}。COOP/COEP が有効な localhost で開いてください。`;
  updateForm();
}

form.addEventListener("input", (event) => {
  if (event.target === verifyOption) {
    verifySelection = verifyOption.checked;
  }
  updateForm();
});
form.addEventListener("change", (event) => {
  if (event.target === verifyOption) {
    verifySelection = verifyOption.checked;
  }
  if (event.target.name === "operation") {
    void readSelectedFileIdcode();
    return;
  }
  updateForm();
});
boardSelect.addEventListener("change", updateForm);
fileInput.addEventListener("change", readSelectedFileIdcode);
offsetResetButton.addEventListener("click", () => {
  offsetOption.value = "0";
  updateForm();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supportAvailable || activeWorker !== null || !fileIdcodeReady) return;

  const board = getBoard(boardSelect.value);
  const options = readOptions();
  const file = selectedFsSource();
  const errors = board
    ? validateOptions(board.id, options, { fileSizes: fileSizes() })
    : ["ボードを選択してください。"];
  if (errors.length > 0 || !board) {
    updateForm();
    return;
  }

  programButton.disabled = true;
  try {
    await startRun(board, options, file, selectedFileIdcode);
  } catch (error) {
    if (activeWorker !== null) {
      clearTimeout(activeWorker.runTimeout);
      activeWorker.terminate();
      activeWorker = null;
    }
    showRunPanel(options.operation);
    const result = classifyResult({
      exitCode: 1,
      log: String(error),
      operation: options.operation,
    });
    setResult(`失敗：${result.reason}`);
  } finally {
    updateForm();
  }
});

updateForm();
initialize();
initializeIde({
  form,
  boardSelect,
  programLog,
  BOARDS,
  onFsSourceChange: (source) => {
    projectFsSource = source;
    void readSelectedFileIdcode();
  },
  onBuildStateChange: (running) => {
    synthesisBuildRunning = running;
    updateForm();
  },
  onSimulationStateChange: (running) => {
    synthesisBuildRunning = running;
    updateForm();
  },
  canStartSimulation: () => !activeWorker && !synthesisBuildRunning,
  canChangeLibraries: () => !activeWorker,
});
