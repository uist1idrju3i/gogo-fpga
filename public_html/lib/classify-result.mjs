const IDCODE_MISMATCH =
  /mismatch between target['’]s idcode and bitstream idcode|idcode.{0,30}(?:mismatch|does not match)|(?:mismatch|does not match).{0,30}idcode/i;
const DEVICE_MISSING =
  /unable to open ftdi device|device not found|no device found|jtag init failed|notfounderror|device disconnected/i;
const UNSUPPORTED_BOARD = /cannot find board/i;
const INVALID_FILE = /fsparser|can't parse file|cannot parse file/i;
const TIMEOUT = /etimedout|timed?\s*out|timeout/i;
const RUNTIME_FAILURE =
  /suspenderror|trying to suspend without webassembly\.promising|shared typed array|atomics\.waitasync/i;

export function classifyResult({
  exitCode,
  log = "",
  timedOut = false,
  operation = "write",
}) {
  const failureReason = operation === "dump"
    ? "読み出し失敗"
    : operation === "erase"
      ? "消去失敗"
      : "書き込み失敗";
  if (timedOut || TIMEOUT.test(log)) {
    return { ok: false, reason: "タイムアウト" };
  }
  if (IDCODE_MISMATCH.test(log)) {
    return { ok: false, reason: "IDCODE 不一致" };
  }
  if (DEVICE_MISSING.test(log)) {
    return { ok: false, reason: "デバイスなし" };
  }
  if (UNSUPPORTED_BOARD.test(log)) {
    return { ok: false, reason: "未対応のボード" };
  }
  if (INVALID_FILE.test(log)) {
    return { ok: false, reason: "ファイル読み込み失敗" };
  }
  if (RUNTIME_FAILURE.test(log)) {
    return { ok: false, reason: "実行環境エラー" };
  }
  if (exitCode !== 0 || /\bFAIL\b/i.test(log)) {
    return { ok: false, reason: failureReason };
  }
  return { ok: true, reason: "成功" };
}
