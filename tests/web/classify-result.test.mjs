import assert from "node:assert/strict";
import test from "node:test";

import { classifyResult } from "../../web/lib/classify-result.mjs";

test("classifyResult succeeds only for a clean zero exit", () => {
  assert.deepEqual(classifyResult({ exitCode: 0, log: "Done" }), {
    ok: true,
    reason: "成功",
  });
  assert.deepEqual(classifyResult({ exitCode: 0, log: "FAIL" }), {
    ok: false,
    reason: "書き込み失敗",
  });
  assert.deepEqual(classifyResult({ exitCode: 1, log: "Done" }), {
    ok: false,
    reason: "書き込み失敗",
  });
});

test("classifyResult recognizes timeout, IDCODE, USB, board, and file errors", () => {
  assert.equal(
    classifyResult({ exitCode: 1, timedOut: true }).reason,
    "タイムアウト",
  );
  assert.equal(
    classifyResult({ exitCode: 1, log: "ETIMEDOUT" }).reason,
    "タイムアウト",
  );
  assert.equal(
    classifyResult({
      exitCode: 1,
      log: "mismatch between target's idcode and bitstream idcode",
    }).reason,
    "IDCODE 不一致",
  );
  assert.equal(
    classifyResult({
      exitCode: 1,
      log: "unable to open ftdi device: -3 (device not found)",
    }).reason,
    "デバイスなし",
  );
  assert.equal(
    classifyResult({ exitCode: 1, log: "NotFoundError: Device disconnected" })
      .reason,
    "デバイスなし",
  );
  assert.equal(
    classifyResult({ exitCode: 1, log: "Error: cannot find board" }).reason,
    "未対応のボード",
  );
  assert.equal(
    classifyResult({ exitCode: 1, log: "FsParser: Potential corrupted file" })
      .reason,
    "ファイル読み込み失敗",
  );
  assert.equal(
    classifyResult({
      exitCode: 1,
      log: "TypeError: [object Int32Array] is not a shared typed array",
    }).reason,
    "実行環境エラー",
  );
});
