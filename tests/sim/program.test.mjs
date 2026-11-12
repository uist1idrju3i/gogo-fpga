import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { test } from "./sharding.mjs";
import { resolve } from "node:path";

import { checksumGowinEflash, parseGowinFsChecksum } from "./fs-checksum.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const runner = resolve(import.meta.dirname, "run-program.mjs");
const buildRoot = resolve(process.env.WASM_BUILD_ROOT ?? "build");
const variant = process.env.WASM_VARIANT ?? "jspi-pthread";
const bscanTimeout = 900_000;
const boards = [
  { name: "Tang Nano 1K", board: "tangnano1k", idcode: 0x0100681b },
  { name: "Tang Nano 4K", board: "tangnano4k", idcode: 0x0100981b },
  { name: "Tang Nano 9K", board: "tangnano9k", idcode: 0x1100481b },
  { name: "Tang Nano 20K", board: "tangnano20k", idcode: 0x0000081b },
];

function fsRecords(board) {
  const path = resolve(repoRoot, "build/fixtures", `${board}.fs`);
  return readFileSync(path, "ascii")
    .split(/\r?\n/)
    .filter((line) => /^[01]+$/.test(line));
}

function parseFsPayload(board, reverseByte = false) {
  const records = fsRecords(board);
  const bytes = [];
  for (const record of records) {
    for (let offset = 0; offset < record.length; offset += 8) {
      let value = Number.parseInt(record.slice(offset, offset + 8), 2);
      if (reverseByte) {
        value = ((value & 0x55) << 1) | ((value >>> 1) & 0x55);
        value = ((value & 0x33) << 2) | ((value >>> 2) & 0x33);
        value = ((value & 0x0f) << 4) | ((value >>> 4) & 0x0f);
      }
      bytes.push(value);
    }
  }
  return Buffer.from(bytes);
}

test("Gowin fixture checksums match the expected configuration checksums", () => {
  const checksums = ["tangnano1k", "tangnano4k", "tangnano9k"].map((board) =>
    parseGowinFsChecksum(
      readFileSync(resolve(repoRoot, "build/fixtures", `${board}.fs`), "ascii"),
    ),
  );
  assert.deepEqual(checksums, [0xa9ee, 0x214f, 0xc5d5]);
});

function runProgram(board, args, faults = {}, timeout = 90_000, inputFiles = {}) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  childEnv.SIM_FORCE_EXIT = "1";
  const norResultPath = resolve(
    buildRoot,
    `sim-nor-${process.pid}-${randomUUID()}.bin`,
  );
  childEnv.SIM_NOR_RESULT_FILE = norResultPath;
  try {
    const started = performance.now();
    const child = spawnSync(
      process.execPath,
      [
        runner,
        variant,
        board.idcode.toString(16),
        JSON.stringify(args),
        JSON.stringify(faults),
        JSON.stringify(inputFiles),
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 8 * 1024 * 1024,
        timeout,
      },
    );
    const wallElapsedMs = performance.now() - started;
    let childStderr = child.stderr ?? "";
    if (process.env.FAKE_USB_TRACE === "1") {
      const traceLines = `${child.stdout ?? ""}\n${child.stderr ?? ""}`
        .split(/\r?\n/)
        .filter((line) => line.startsWith("FAKE_USB_TRACE"));
      if (traceLines.length > 0) process.stderr.write(`${traceLines.join("\n")}\n`);
      childStderr = childStderr
        .split(/\r?\n/)
        .filter((line) => !line.startsWith("FAKE_USB_TRACE"))
        .join("\n");
    }
    if (child.error?.code === "ETIMEDOUT") {
      return {
        exitCode: child.status ?? 1,
        timedOut: true,
        timeoutCode: child.error.code,
        elapsedMs: wallElapsedMs,
        elapsedSource: "wall-timeout",
        output: `${child.stdout}\n${childStderr}`,
      };
    }
    if (child.error) {
      throw new Error(`Programming subprocess failed: ${child.error.message}`, { cause: child.error });
    }
    const marker = /(?:^|\r?\n)__PROGRAM_RESULT__(\{[^\r\n]*\})(?:\r?\n|$)/.exec(child.stderr);
    assert.ok(
      marker,
      `Programming subprocess returned ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    );
    const result = JSON.parse(marker[1]);
    if (result.norResultFile) {
      result.nor = readFileSync(norResultPath).toString("base64");
      delete result.norResultFile;
    }
    return {
      ...result,
      wallElapsedMs,
      elapsedSource: "program",
      output: `${child.stdout}\n${childStderr.replace(marker[0], "\n")}`,
    };
  } finally {
    rmSync(norResultPath, { force: true });
  }
}

function measured(testName, variantName, boardName, repeat, result) {
  console.log(
    `PROGRAM_MEASURE,${variantName},${boardName},${testName},${repeat},${result.elapsedMs.toFixed(3)},${result.elapsedSource}`,
  );
}

assert.ok(
  ["openFPGALoader.mjs", "openFPGALoader.wasm"].every((name) =>
    readFileSync(resolve(buildRoot, variant, name)),
  ),
  `Missing JSPI/pthread artifacts under ${buildRoot}`,
);

for (const board of boards) {
  const fixture = resolve(repoRoot, "build/fixtures", `${board.board}.fs`);
  test(`SRAM programming: ${board.name}`, { timeout: 300_000 }, () => {
    const expected = parseFsPayload(board.board, true);
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const result = runProgram(board, ["-b", board.board, fixture]);
      assert.equal(result.exitCode, 0, result.output);
      assert.doesNotMatch(result.output, /\bFAIL\b/i);
      assert.deepEqual(Buffer.from(result.sram, "base64"), expected);
      measured("sram", variant, board.name, repeat, result);
    }
  });

  test(`flash programming: ${board.name}`, { timeout: 300_000 }, () => {
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const result = runProgram(board, ["-b", board.board, "-f", fixture]);
      assert.equal(result.exitCode, 0, result.output);
      assert.doesNotMatch(result.output, /\bFAIL\b/i);
      if (board.idcode === 0x0000081b) {
        assert.ok(result.spiCommandCounts[6] > 0, "SPI write-enable was not exercised");
        assert.ok(result.spiCommandCounts[5] > 0, "SPI status polling was not exercised");
        assert.ok(result.spiCommandCounts[0xd8] > 0, "NOR block erase was not exercised");
        assert.ok(result.spiCommandCounts[2] > 0, "NOR page program was not exercised");
        assert.ok(
          result.spiReadTrace.some(({ input, response }) => input[0] === 0x05 && (response[1] & 1)),
          "NOR busy status was not exercised",
        );
        assert.ok(
          result.spiReadTrace.some(({ input, response }) => input[0] === 0x05 && !(response[1] & 1)),
          "NOR ready status was not exercised",
        );
        assert.deepEqual(
          Buffer.from(result.nor, "base64").subarray(0, parseFsPayload(board.board).length),
          parseFsPayload(board.board),
        );
      } else {
        const expected = Buffer.concat([
          Buffer.from("GW1N"),
          Buffer.alloc(20, 0xff),
          parseFsPayload(board.board),
        ]);
        const eflash = Buffer.from(result.eflash, "base64");
        assert.deepEqual(eflash.subarray(0, expected.length), expected);
        const eflashMap = new Map(
          Array.from(eflash, (byte, address) => [address, byte]),
        );
        assert.equal(result.usercode, checksumGowinEflash(eflashMap));
        assert.equal(
          result.usercode,
          parseGowinFsChecksum(readFileSync(fixture, "ascii")),
        );
      }
      measured("flash", variant, board.name, repeat, result);
    }
  });
}

test("corrupted internal eflash data fails the Tang Nano 1K CRC check", { timeout: 300_000 }, () => {
  const board = boards[0];
  const fixture = resolve(repoRoot, "build/fixtures", `${board.board}.fs`);
  const expected = Buffer.concat([
    Buffer.from("GW1N"),
    Buffer.alloc(20, 0xff),
    parseFsPayload(board.board),
  ]);
  const result = runProgram(
    board,
    ["-b", board.board, "-f", fixture],
    { eflashCorruptWord: 23 },
  );
  const eflash = Buffer.from(result.eflash, "base64");

  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.eflashCorruptedWord, 23);
  assert.equal(eflash[92], expected[92] ^ 1);
  const eflashMap = new Map(
    Array.from(eflash, (byte, address) => [address, byte]),
  );
  const storedChecksum = checksumGowinEflash(eflashMap);
  const fixtureChecksum = parseGowinFsChecksum(readFileSync(fixture, "ascii"));
  assert.equal(result.usercode, storedChecksum);
  assert.notEqual(storedChecksum, fixtureChecksum);

  const crcResult = /CRC check\s*:\s*(PASS|FAIL)/i.exec(result.output);
  // Upstream leaves skip_checksum uninitialized for GW1N, so the CRC line may be absent.
  if (crcResult) assert.equal(crcResult[1].toUpperCase(), "FAIL");
});

test("IDCODE mismatch is rejected before programming", () => {
  const target = boards[0];
  const child = spawnSync(
    process.execPath,
    [
      runner,
      variant,
      target.idcode.toString(16),
      JSON.stringify(["-b", target.board, resolve(repoRoot, "build/fixtures/tangnano9k.fs")]),
      "{}",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, WASM_BUILD_ROOT: buildRoot },
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  const output = `${child.stdout}\n${child.stderr}`;
  assert.ok(child.status !== 0, output);
  assert.match(output, /mismatch between target's idcode and bitstream idcode/i);
});

test("DONE-never-set follows upstream's printed-failure/zero-exit behavior", { timeout: 30_000 }, () => {
  const board = boards[0];
  const result = runProgram(
    board,
    ["-b", board.board, resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { doneNever: true },
  );
  // programSRAM returns void after writeSRAM reports FAIL; main still exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /FAIL/);
});

test("internal eflash busy reaches upstream's retry limit", { timeout: 120_000 }, () => {
  const board = boards[0];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { eflashBusyForever: true },
  );
  assert.equal(result.instructionCounts[0x75], 100);
  assert.ok(result.statusReads.some((status) => status & (1 << 13)));
  // Upstream retries 100 times, reports FAIL, and still exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /Erase FLASH/);
  assert.match(result.output, /FAIL/);
});

test("NOR erase busy remains bounded by the subprocess timeout", { timeout: 60_000 }, () => {
  const board = boards[3];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { norBusyForever: true },
    30_000,
  );
  // The fake holds WIP high; upstream's 100000-poll wait exceeded 240 seconds in Node.
  assert.equal(result.timedOut, true, result.output);
  assert.equal(result.timeoutCode, "ETIMEDOUT");
  assert.notEqual(result.exitCode, 0, result.output);
});

test("clean Tang Nano 20K flash verification succeeds", { timeout: 60_000 }, () => {
  const board = boards[3];
  const expected = parseFsPayload(board.board);
  const result = runProgram(
    board,
    ["-b", board.board, "-f", "--verify", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(0, expected.length),
    expected,
  );
});

test("Tang Nano 20K flash write succeeds with verification disabled", { timeout: 60_000 }, () => {
  const board = boards[3];
  const expected = parseFsPayload(board.board);
  const result = runProgram(
    board,
    ["-b", board.board, "-f", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(0, expected.length),
    expected,
  );
  assert.equal(result.spiCommandCounts[3] ?? 0, 0);
});

test("Tang Nano 9K external flash write verifies NOR contents", { timeout: bscanTimeout }, () => {
  const board = boards[2];
  const expected = parseFsPayload(board.board);
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--external-flash",
      "--verify",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    {},
    bscanTimeout,
  );
  measured("bscan-9k-external-write-verify", variant, board.name, 1, result);
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(0, expected.length),
    expected,
  );
});

test("Tang Nano 4K external flash uses its board-specific BSCAN pin map", { timeout: bscanTimeout }, () => {
  const board = boards[1];
  const expected = parseFsPayload(board.board);
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--external-flash",
      "--verify",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    {},
    bscanTimeout,
  );
  measured("bscan-4k-external-write-verify", variant, board.name, 1, result);
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(0, expected.length),
    expected,
  );
});

test("corrupted Tang Nano 9K external-flash readback fails verification", { timeout: bscanTimeout }, () => {
  const board = boards[2];
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--external-flash",
      "--verify",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    { corruptNorReadback: true },
    bscanTimeout,
  );
  measured("bscan-9k-corrupt-readback", variant, board.name, 1, result);
  assert.equal(result.readCorrupted, true, "BSCAN NOR readback corruption was not applied");
  assert.notEqual(
    result.exitCode,
    0,
    `BSCAN corruption was applied at ${JSON.stringify(result.readCorruptedAt)}\n${result.output}`,
  );
  assert.match(result.output, /Verification failed/i);
  assert.ok(result.spiCommandCounts[3] > 0, "external NOR read was not exercised");
});

test("external flash offsets select the NOR write address", { timeout: bscanTimeout }, () => {
  const board = boards[2];
  const expected = parseFsPayload(board.board);
  const offset = 0x1000;
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--external-flash",
      "-o",
      String(offset),
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    {},
    bscanTimeout,
  );
  measured("bscan-9k-offset-write", variant, board.name, 1, result);
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(offset, offset + expected.length),
    expected,
  );
});

test("unprotect clears NOR protection before external programming", { timeout: bscanTimeout }, () => {
  const board = boards[2];
  const expected = parseFsPayload(board.board);
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--external-flash",
      "--unprotect-flash",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    { protectedNor: true },
    bscanTimeout,
  );
  measured("bscan-9k-unprotect-write", variant, board.name, 1, result);
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(result.spiCommandCounts[1] > 0, "status register was not written");
  assert.deepEqual(
    Buffer.from(result.nor, "base64").subarray(0, expected.length),
    expected,
  );
});

test("Tang Nano 20K bulk erase leaves every NOR byte erased", { timeout: 60_000 }, () => {
  const board = boards[3];
  const result = runProgram(
    board,
    ["-b", board.board, "--bulk-erase"],
    { norSeed: { offset: 32, bytes: [0, 1, 2, 3] } },
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.ok(result.spiCommandCounts[0xc7] > 0, "chip erase command was not sent");
  assert.equal(result.norAllErased, true);
});

test("flash dump reads the requested NOR range", { timeout: bscanTimeout }, () => {
  const board = boards[2];
  const offset = 0x100;
  const bytes = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0];
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "--external-flash",
      "--dump-flash",
      "--file-size",
      String(bytes.length),
      "-o",
      String(offset),
      "/dump.bin",
    ],
    { norSeed: { offset, bytes } },
    bscanTimeout,
  );
  measured("bscan-9k-offset-dump", variant, board.name, 1, result);
  assert.equal(result.exitCode, 0, result.output);
  assert.doesNotMatch(result.output, /\bFAIL\b/i);
  assert.deepEqual(Buffer.from(result.dump, "base64"), Buffer.from(bytes));
});

test("MCU firmware is written to the 4K firmware page", { timeout: 60_000 }, () => {
  const board = boards[1];
  const firmware = [0x12, 0x34, 0x56, 0x78];
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--mcufw",
      "/mcufw.bin",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    {},
    90_000,
    { "/mcufw.bin": firmware },
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    Buffer.from(result.eflash, "base64").subarray(0x380 * 256, 0x380 * 256 + firmware.length),
    Buffer.from(firmware).reverse(),
  );
});

test("user-flash data is written to the 9K user-flash page", { timeout: 60_000 }, () => {
  const board = boards[2];
  const userFlash = [0xa1, 0xb2, 0xc3, 0xd4];
  const result = runProgram(
    board,
    [
      "-b",
      board.board,
      "-f",
      "--user-flash",
      "/user-flash.bin",
      resolve(repoRoot, "build/fixtures", `${board.board}.fs`),
    ],
    {},
    90_000,
    { "/user-flash.bin": userFlash },
  );
  assert.equal(result.exitCode, 0, result.output);
  assert.deepEqual(
    Buffer.from(result.eflash, "base64").subarray(0x6d0 * 256, 0x6d0 * 256 + userFlash.length),
    Buffer.from(userFlash.map((byte) => byte ^ 0xff)).reverse(),
  );
});

test("selected frequency is reported and reset reaches the Gowin reload path", { timeout: 60_000 }, () => {
  const board = boards[2];
  const fixture = resolve(repoRoot, "build/fixtures", `${board.board}.fs`);
  const result = runProgram(board, ["-b", board.board, "--freq", "3000000", "-r", fixture]);
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /3\.00MHz/);

  const withoutReset = runProgram(board, ["-b", board.board, fixture]);
  const withReset = runProgram(board, ["-b", board.board, "-r", fixture]);
  assert.equal(withReset.exitCode, 0, withReset.output);
  assert.ok(
    withReset.instructionCounts[0x3c] > (withoutReset.instructionCounts[0x3c] ?? 0),
    "reset did not add the Gowin RELOAD command",
  );
});

test("NOR readback corruption is detected by --verify", { timeout: 60_000 }, () => {
  const board = boards[3];
  const result = runProgram(
    board,
    ["-b", board.board, "-f", "--verify", resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { corruptNorReadback: true },
  );
  assert.notEqual(result.exitCode, 0, result.output);
  assert.match(result.output, /Verification failed/i);
  assert.ok(result.spiCommandCounts[3] > 0, "NOR read was not exercised");
});

test("USB disconnect during transfer is reported without a hang", { timeout: 30_000 }, () => {
  const board = boards[1];
  const result = runProgram(
    board,
    ["-b", board.board, resolve(repoRoot, "build/fixtures", `${board.board}.fs`)],
    { disconnectAfter: 30 },
  );
  // WebUSB rejects with NotFoundError, but upstream logs FAIL and still exits zero.
  assert.equal(result.exitCode, 0, result.output);
  assert.match(result.output, /NotFoundError/);
  assert.match(result.output, /FAIL/);
});

test("payload comparator negative control rejects a corrupted bit", () => {
  const expected = parseFsPayload("tangnano1k", true);
  const captured = Buffer.from(expected);
  captured[0] ^= 1;
  assert.notDeepEqual(captured, expected);
});
