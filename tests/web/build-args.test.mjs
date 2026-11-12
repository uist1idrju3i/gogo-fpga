import assert from "node:assert/strict";
import test from "node:test";

import { buildArgs } from "../../web/lib/build-args.mjs";
import { defaultOptions } from "../../web/lib/options.mjs";

function settings(overrides = {}) {
  return { ...defaultOptions(), ...overrides };
}

test("buildArgs preserves the default SRAM and flash commands", () => {
  for (const board of ["tangnano1k", "tangnano4k", "tangnano9k", "tangnano20k"]) {
    assert.deepEqual(buildArgs({ board, options: settings() }), [
      "-b",
      board,
      "/input.fs",
    ]);
  }

  for (const board of ["tangnano1k", "tangnano4k", "tangnano9k"]) {
    assert.deepEqual(buildArgs({
      board,
      options: settings({ target: "flash" }),
    }), ["-b", board, "-f", "/input.fs"]);
  }
  assert.deepEqual(buildArgs({
    board: "tangnano20k",
    options: settings({ target: "flash", flashType: "external" }),
  }), ["-b", "tangnano20k", "-f", "--verify", "/input.fs"]);
});

test("external flash writes verify by default and can disable verification", () => {
  for (const board of ["tangnano4k", "tangnano9k", "tangnano20k"]) {
    const defaults = settings({ target: "flash", flashType: "external" });
    assert.deepEqual(buildArgs({ board, options: defaults }), [
      "-b",
      board,
      "-f",
      ...(board === "tangnano20k" ? [] : ["--external-flash"]),
      "--verify",
      "/input.fs",
    ]);
    assert.deepEqual(buildArgs({
      board,
      options: { ...defaults, verify: false },
    }), [
      "-b",
      board,
      "-f",
      ...(board === "tangnano20k" ? [] : ["--external-flash"]),
      "/input.fs",
    ]);
  }
});

test("buildArgs orders options before the positional input file", () => {
  assert.deepEqual(buildArgs({
    board: "tangnano9k",
    options: settings({
      target: "flash",
      flashType: "external",
      verify: true,
      offset: "0x100",
      unprotectFlash: true,
      frequency: "3000000",
      reset: true,
      verbosity: "verbose",
    }),
  }), [
    "-b",
    "tangnano9k",
    "--freq",
    "3000000",
    "-v",
    "-f",
    "--external-flash",
    "--verify",
    "-o",
    "256",
    "--unprotect-flash",
    "-r",
    "/input.fs",
  ]);
  assert.deepEqual(buildArgs({
    board: "tangnano4k",
    options: settings({
      target: "flash",
      mcufw: true,
      verbosity: "debug",
    }),
  }), [
    "-b",
    "tangnano4k",
    "--verbose-level",
    "2",
    "-f",
    "--mcufw",
    "/mcufw.bin",
    "/input.fs",
  ]);
  assert.deepEqual(buildArgs({
    board: "tangnano9k",
    options: settings({
      target: "flash",
      userFlash: true,
    }),
  }), [
    "-b",
    "tangnano9k",
    "-f",
    "--user-flash",
    "/user-flash.bin",
    "/input.fs",
  ]);
});

test("buildArgs creates read and erase commands", () => {
  assert.deepEqual(buildArgs({
    board: "tangnano4k",
    options: settings({
      operation: "dump",
      flashType: "external",
      dumpSize: "custom",
      dumpSizeBytes: "0x40",
      offset: "0x100",
    }),
  }), [
    "-b",
    "tangnano4k",
    "--external-flash",
    "--dump-flash",
    "--file-size",
    "64",
    "-o",
    "256",
    "/dump.bin",
  ]);
  assert.deepEqual(buildArgs({
    board: "tangnano20k",
    options: settings({
      operation: "dump",
      flashType: "external",
    }),
  }), [
    "-b",
    "tangnano20k",
    "--dump-flash",
    "--file-size",
    String(8 * 1024 * 1024),
    "/dump.bin",
  ]);
  assert.deepEqual(buildArgs({
    board: "tangnano20k",
    options: settings({
      operation: "erase",
      flashType: "external",
    }),
  }), ["-b", "tangnano20k", "--bulk-erase"]);
});

test("buildArgs rejects unknown boards and inapplicable options", () => {
  assert.throws(
    () => buildArgs({ board: "unknown", options: settings() }),
    { name: "RangeError" },
  );
  assert.throws(
    () => buildArgs({
      board: "tangnano1k",
      options: settings({ target: "flash", flashType: "external" }),
    }),
    { name: "RangeError" },
  );
  assert.throws(
    () => buildArgs({
      board: "tangnano20k",
      options: settings({ operation: "erase", flashType: "external", unprotectFlash: true }),
    }),
    { name: "RangeError" },
  );
  assert.throws(
    () => buildArgs({
      board: "tangnano4k",
      options: settings({ operation: "erase", flashType: "external" }),
    }),
    { name: "RangeError" },
  );
  assert.throws(
    () => buildArgs({
      board: "tangnano9k",
      options: settings({ target: "flash", flashType: "external", offset: "-1" }),
    }),
    { name: "RangeError" },
  );
});
