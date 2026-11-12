import assert from "node:assert/strict";
import test from "node:test";

import { BOARDS } from "../../web/lib/boards.mjs";
import {
  defaultOptions,
  getApplicability,
  validateOptions,
} from "../../web/lib/options.mjs";

function settings(overrides = {}) {
  return { ...defaultOptions(), ...overrides };
}

test("defaultOptions selects a write with upstream defaults", () => {
  assert.deepEqual(defaultOptions(), {
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
  });
});

test("applicability covers each board and operation", () => {
  for (const board of BOARDS) {
    const expected = {
      write: true,
      dump: board.id !== "tangnano1k",
      erase: board.id === "tangnano20k",
    };
    for (const operation of ["write", "dump", "erase"]) {
      const options = settings({
        operation,
        target: "flash",
        flashType: "external",
      });
      const applicability = getApplicability(board.id, options);
      assert.equal(applicability.operation[operation].enabled, expected[operation]);
      assert.equal(applicability.frequency.enabled, true);
      assert.equal(applicability.verbosity.enabled, true);
      assert.equal(applicability.protectFlash.enabled, false);
      assert.ok(applicability.protectFlash.reason);
      assert.equal(applicability.reset.enabled, operation === "write");
      assert.equal(applicability.dumpSize.enabled, operation === "dump" && expected.dump);
      assert.equal(applicability.offset.enabled, (operation === "dump" && expected.dump) || (
        operation === "write" && board.id !== "tangnano1k"
      ));
      assert.equal(applicability.unprotectFlash.enabled, operation === "write" && (
        board.id !== "tangnano1k"
      ));
      assert.equal(applicability.verify.enabled, operation === "write" && (
        board.id !== "tangnano1k"
      ));
    }
  }
});

test("applicability distinguishes SRAM, internal flash, and external flash writes", () => {
  for (const board of BOARDS) {
    const sram = getApplicability(board.id, settings());
    assert.equal(sram.verify.enabled, false);
    assert.equal(sram.offset.enabled, false);
    assert.equal(sram.reset.enabled, true);

    const internal = getApplicability(board.id, settings({
      target: "flash",
      flashType: "internal",
    }));
    assert.equal(internal.internalFlash.enabled, board.id !== "tangnano20k");
    assert.equal(internal.verify.enabled, false);
    assert.equal(internal.offset.enabled, false);
    assert.equal(internal.unprotectFlash.enabled, false);
    assert.equal(internal.mcufw.enabled, board.id === "tangnano4k");
    assert.equal(internal.userFlash.enabled, board.id === "tangnano9k");

    const external = getApplicability(board.id, settings({
      target: "flash",
      flashType: "external",
    }));
    assert.equal(external.externalFlash.enabled, board.id !== "tangnano1k");
    assert.equal(external.verify.enabled, board.id !== "tangnano1k");
    assert.equal(external.offset.enabled, board.id !== "tangnano1k");
    assert.equal(external.unprotectFlash.enabled, board.id !== "tangnano1k");
    assert.equal(external.mcufw.enabled, false);
    assert.equal(external.userFlash.enabled, false);
  }
});

test("applicability explains unsupported flash choices", () => {
  const oneK = getApplicability("tangnano1k", settings({
    target: "flash",
    flashType: "external",
  }));
  assert.equal(oneK.externalFlash.enabled, false);
  assert.equal(oneK.externalFlash.reason, "外付けフラッシュが実装されていません。");
  assert.equal(oneK.operation.dump.enabled, false);
  assert.equal(oneK.operation.erase.enabled, false);

  const twentyK = getApplicability("tangnano20k", settings({
    target: "flash",
    flashType: "internal",
  }));
  assert.equal(twentyK.internalFlash.enabled, false);
  assert.match(twentyK.internalFlash.reason, /内蔵フラッシュはありません/);

  const erase = getApplicability("tangnano20k", settings({
    operation: "erase",
    flashType: "external",
  }));
  assert.equal(erase.unprotectFlash.enabled, false);
  assert.match(erase.unprotectFlash.reason, /使われません/);
});

test("validateOptions accepts valid writes, dumps, and erase", () => {
  assert.deepEqual(validateOptions("tangnano4k", settings(), {
    fileSizes: { fs: 128 },
  }), []);
  assert.deepEqual(validateOptions("tangnano4k", settings({
    target: "flash",
    flashType: "external",
    offset: "0x3fffff",
  }), {
    fileSizes: { fs: 1 },
  }), []);
  assert.deepEqual(validateOptions("tangnano20k", settings({
    operation: "dump",
    flashType: "external",
    dumpSize: "custom",
    dumpSizeBytes: "1",
    offset: "0x7fffff",
  })), []);
  assert.deepEqual(validateOptions("tangnano20k", settings({
    operation: "erase",
    flashType: "external",
  })), []);
});

test("validateOptions rejects invalid and out-of-range offsets and lengths", () => {
  for (const offset of ["-1", "1.5", "xyz", "0x", "9007199254740992"]) {
    assert.ok(validateOptions("tangnano4k", settings({
      target: "flash",
      flashType: "external",
      offset,
    }), { fileSizes: { fs: 1 } }).length > 0, offset);
  }
  assert.ok(validateOptions("tangnano4k", settings({
    target: "flash",
    flashType: "external",
    offset: "0x400000",
  }), { fileSizes: { fs: 1 } }).some((error) => error.includes("容量を超え")));
  assert.ok(validateOptions("tangnano4k", settings({
    target: "flash",
    flashType: "external",
    offset: "0x400001",
  })).some((error) => error.includes("容量を超え")));
  assert.ok(validateOptions("tangnano20k", settings({
    operation: "dump",
    flashType: "external",
    dumpSize: "custom",
    dumpSizeBytes: "0",
  })).some((error) => error.includes("サイズ")));
  assert.ok(validateOptions("tangnano20k", settings({
    operation: "dump",
    flashType: "external",
    dumpSize: "custom",
    dumpSizeBytes: "2",
    offset: "0x7fffff",
  })).some((error) => error.includes("容量を超え")));
});

test("validateOptions rejects unsupported and missing file options", () => {
  assert.ok(validateOptions("unknown", settings()).some((error) => error.includes("未対応")));
  assert.ok(validateOptions("tangnano1k", settings({
    target: "flash",
    flashType: "external",
  })).length > 0);
  assert.ok(validateOptions("tangnano4k", settings({
    operation: "erase",
    flashType: "external",
  })).length > 0);
  assert.ok(validateOptions("tangnano20k", settings({
    operation: "erase",
    flashType: "external",
    unprotectFlash: true,
  })).some((error) => error.includes("--unprotect-flash")));
  assert.ok(validateOptions("tangnano4k", settings({
    target: "flash",
    mcufw: true,
  }), { fileSizes: { fs: 128 } }).some((error) => error.includes("MCU ファームウェア")));
  assert.ok(validateOptions("tangnano9k", settings({
    target: "flash",
    userFlash: true,
  }), { fileSizes: { fs: 128 } }).some((error) => error.includes("ユーザー フラッシュ")));
  assert.ok(validateOptions("tangnano4k", settings({
    protectFlash: true,
  })).length > 0);
  assert.ok(validateOptions("tangnano4k", settings({
    verify: false,
  })).some((error) => error.includes("検証に対応していません")));
  assert.ok(validateOptions("tangnano4k", settings(), {
    fileSizes: {},
  }).some((error) => error.includes("ビットストリーム")));
});

test("validateOptions requires flash files and enforces flash capacity", () => {
  assert.ok(validateOptions("tangnano9k", settings({
    target: "flash",
    flashType: "external",
    offset: "0x3fffff",
  }), { fileSizes: { fs: 2 } }).some((error) => error.includes("容量を超え")));
  assert.ok(validateOptions("tangnano4k", settings({
    target: "flash",
    flashType: "internal",
  }), { fileSizes: { fs: -1 } }).length > 0);
});
