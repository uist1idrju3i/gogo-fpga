import { getBoard } from "./boards.mjs";

const FREQUENCIES = new Set([
  "default",
  "1000000",
  "2500000",
  "3000000",
  "10000000",
]);
const VERBOSITY = new Set(["default", "verbose", "debug"]);

export function defaultOptions() {
  return {
    operation: "write",
    target: "sram",
    flashType: "internal",
    verify: "default",
    offset: "0",
    unprotectFlash: false,
    frequency: "default",
    reset: false,
    verbosity: "default",
    mcufw: false,
    userFlash: false,
    protectFlash: false,
    dumpSize: "all",
    dumpSizeBytes: "",
  };
}

function option(enabled, reason = "") {
  return { enabled, reason };
}

function parseByteValue(value) {
  const text = String(value ?? "").trim();
  if (!/^(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) {
    return null;
  }
  const number = Number(text.startsWith("0x") || text.startsWith("0X")
    ? BigInt(text)
    : text);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function currentOperation(options) {
  return options?.operation;
}

export function getApplicability(boardId, options) {
  const board = getBoard(boardId);
  const operation = currentOperation(options);
  const isWrite = operation === "write";
  const isFlashWrite = isWrite && options.target === "flash";
  const isInternalWrite = isFlashWrite && options.flashType === "internal";
  const hasExternalFlash = board !== null && board.id !== "tangnano1k";
  const isExternalWrite = isFlashWrite && options.flashType === "external" && hasExternalFlash;
  const canDump = hasExternalFlash;
  const canErase = board?.id === "tangnano20k";

  const noExternalFlash = "外付けフラッシュが実装されていません。";
  const noInternalFlash = "Tang Nano 20K に内蔵フラッシュはありません。";
  const unsupportedErase =
    "openFPGALoader v1.2.0 は Tang Nano 20K 以外の一括消去に対応していません。";

  return {
    operation: {
      write: option(true),
      dump: option(canDump, canDump ? "" : noExternalFlash),
      erase: option(canErase, canErase ? "" : unsupportedErase),
    },
    target: option(isWrite),
    flashType: option(isFlashWrite || operation === "dump" || operation === "erase"),
    internalFlash: option(
      isFlashWrite && board?.id !== "tangnano20k",
      board?.id === "tangnano20k" ? noInternalFlash : "",
    ),
    externalFlash: option(
      (isFlashWrite && hasExternalFlash) ||
        ((operation === "dump" || operation === "erase") && hasExternalFlash),
      hasExternalFlash ? "" : noExternalFlash,
    ),
    verify: option(
      isExternalWrite,
      isExternalWrite
        ? ""
        : "SRAM と内蔵フラッシュの書き込みは検証に対応していません。",
    ),
    offset: option(
      isExternalWrite || (operation === "dump" && canDump),
      "外付けフラッシュへの書き込みと読み出しで指定できます。",
    ),
    unprotectFlash: option(
      isExternalWrite,
      operation === "erase"
        ? "upstream の全消去処理では --unprotect-flash が使われません。"
        : "外付けフラッシュへの書き込みでのみ使用できます。",
    ),
    frequency: option(true),
    reset: option(isWrite, "リセットは書き込み操作でのみ指定できます。"),
    verbosity: option(true),
    mcufw: option(
      isInternalWrite && board?.id === "tangnano4k",
      "4K の内蔵フラッシュ書き込みでのみ使用できます。",
    ),
    userFlash: option(
      isInternalWrite && board?.id === "tangnano9k",
      "9K の内蔵フラッシュ書き込みでのみ使用できます。",
    ),
    protectFlash: option(
      false,
      "openFPGALoader v1.2.0 は対象の Gowin ボードで対応していません。",
    ),
    dumpSize: option(operation === "dump" && canDump),
  };
}

export function validateOptions(boardId, options, { fileSizes } = {}) {
  const errors = [];
  const board = getBoard(boardId);
  if (!board) {
    return [`未対応のボードです: ${boardId}`];
  }
  if (!options || typeof options !== "object") {
    return ["設定を読み取れません。"];
  }

  const applicability = getApplicability(boardId, options);
  const operation = options.operation;
  if (!["write", "dump", "erase"].includes(operation)) {
    errors.push("操作を選択してください。");
    return errors;
  }
  if (!applicability.operation[operation].enabled) {
    errors.push(applicability.operation[operation].reason);
  }

  if (operation === "write") {
    if (!["sram", "flash"].includes(options.target)) {
      errors.push("書き込み先を選択してください。");
    } else if (options.target === "flash") {
      if (!["internal", "external"].includes(options.flashType)) {
        errors.push("フラッシュの種類を選択してください。");
      } else if (
        options.flashType === "internal" &&
        !applicability.internalFlash.enabled
      ) {
        errors.push(applicability.internalFlash.reason || "内蔵フラッシュは使えません。");
      } else if (
        options.flashType === "external" &&
        !applicability.externalFlash.enabled
      ) {
        errors.push(applicability.externalFlash.reason || "外付けフラッシュは使えません。");
      }
    } else if (options.flashType === "external") {
      errors.push("SRAM 書き込みでは外付けフラッシュを選べません。");
    }
  } else if (options.flashType !== "external") {
    errors.push("読み出しと全消去には外付けフラッシュを指定してください。");
  }

  if (options.verify !== "default" && typeof options.verify !== "boolean") {
    errors.push("検証の設定が不正です。");
  } else if (options.verify !== "default" && !applicability.verify.enabled) {
    errors.push(applicability.verify.reason);
  }

  const offset = parseByteValue(options.offset);
  if (offset === null || offset > 0xffffffff) {
    errors.push("オフセットは 0 以上の整数で指定してください。");
  } else {
    const offsetApplies = applicability.offset.enabled;
    if (!offsetApplies && offset !== 0) {
      errors.push("この操作ではオフセットを指定できません。");
    } else if (
      offsetApplies &&
      (offset > board.flashBytes ||
        (operation === "write" && options.target === "flash" && offset >= board.flashBytes))
    ) {
      errors.push("オフセットがフラッシュ容量を超えています。");
    }
  }

  if (options.unprotectFlash && !applicability.unprotectFlash.enabled) {
    errors.push(applicability.unprotectFlash.reason);
  }
  if (!FREQUENCIES.has(options.frequency)) {
    errors.push("JTAG 周波数の設定が不正です。");
  }
  if (options.reset && !applicability.reset.enabled) {
    errors.push(applicability.reset.reason);
  }
  if (!VERBOSITY.has(options.verbosity)) {
    errors.push("ログの設定が不正です。");
  }
  if (options.mcufw && !applicability.mcufw.enabled) {
    errors.push(applicability.mcufw.reason);
  }
  if (options.userFlash && !applicability.userFlash.enabled) {
    errors.push(applicability.userFlash.reason);
  }
  if (options.protectFlash) {
    errors.push(applicability.protectFlash.reason);
  }

  let dumpSize;
  if (!["all", "custom"].includes(options.dumpSize)) {
    errors.push("読み出しサイズの設定が不正です。");
  } else if (operation === "dump") {
    dumpSize = options.dumpSize === "all"
      ? board.flashBytes
      : parseByteValue(options.dumpSizeBytes);
    if (!Number.isSafeInteger(dumpSize) || dumpSize <= 0 || dumpSize > 0xffffffff) {
      errors.push("読み出すサイズは 1 以上の整数で指定してください。");
    }
  } else if (options.dumpSize !== "all") {
    errors.push("読み出しサイズはフラッシュの読み出しでのみ指定できます。");
  }

  if (fileSizes !== undefined) {
    if (
      operation === "write" &&
      (!Number.isSafeInteger(fileSizes.fs) || fileSizes.fs <= 0)
    ) {
      errors.push("ビットストリームを選択してください。");
    }
    if (options.mcufw && (
      !Number.isSafeInteger(fileSizes.mcufw) || fileSizes.mcufw <= 0
    )) {
      errors.push("MCU ファームウェアを選択してください。");
    }
    if (options.userFlash && (
      !Number.isSafeInteger(fileSizes.userFlash) || fileSizes.userFlash <= 0
    )) {
      errors.push("ユーザー フラッシュのファイルを選択してください。");
    }
  }

  if (offset !== null && offset !== undefined && offset <= 0xffffffff) {
    let length;
    if (operation === "dump") {
      length = dumpSize;
    } else if (
      operation === "write" &&
      options.target === "flash" &&
      options.flashType === "external"
    ) {
      length = fileSizes?.fs;
    }
    if (Number.isSafeInteger(length) && offset + length > board.flashBytes) {
      errors.push("オフセットとデータの合計がフラッシュ容量を超えています。");
    }
  }

  return errors;
}
