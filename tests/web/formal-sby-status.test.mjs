import assert from "node:assert/strict";
import test from "node:test";
import { classifySbyStatus, readSbyStatus } from "../../web/lib/formal-sby-status.mjs";

test("the SBY status file, process exit and final line must agree", () => {
  for (const [status, code] of Object.entries({ PASS: 0, FAIL: 2, UNKNOWN: 4, ERROR: 16, TIMEOUT: 8, CANCELLED: 32 })) {
    const final = `SBY 00:00:00 [result] DONE (${status}, rc=${code})\n`;
    assert.equal(readSbyStatus(`${status} ${code} 1.25\n`, code, final), status);
    assert.throws(() => readSbyStatus(`${status} ${code} 1\n`, code + 1, final));
    assert.throws(() => readSbyStatus(`${status} ${code} 1\n`, code, ""));
    assert.throws(() => readSbyStatus(`${status} ${code + 1} 1\n`, code, final));
  }
});

test("truncated, malformed, duplicated and invented SBY statuses fail closed", () => {
  for (const status of ["", "PASS", "PASS 0 1", "PASS 0 -1\n", "PASS 0 NaN\n", "PASS 0 Infinity\n",
    "PASS 0 1\n\n", "PASS 0 1\nPASS 0 1\n", "SUCCESS 0 1\n", "PASS 0 1\nignored\n", "PASS 0 1e999\n"]) {
    assert.throws(() => readSbyStatus(status, 0, "DONE (PASS, rc=0)"));
  }
});

test("bounded safety, proof and cover remain distinct even with the same PASS status", () => {
  assert.equal(classifySbyStatus("bmc", "PASS"), "bounded-pass");
  assert.equal(classifySbyStatus("prove", "PASS"), "proved");
  assert.equal(classifySbyStatus("cover", "PASS"), "covered");
  assert.equal(classifySbyStatus("bmc", "FAIL"), "counterexample");
  assert.equal(classifySbyStatus("prove", "FAIL"), "counterexample");
  assert.equal(classifySbyStatus("cover", "FAIL"), "unreached");
  for (const mode of ["bmc", "prove", "cover"]) {
    for (const [status, kind] of Object.entries({ UNKNOWN: "unknown", ERROR: "tool-error", TIMEOUT: "timeout", CANCELLED: "cancelled" })) {
      assert.equal(classifySbyStatus(mode, status), kind);
    }
  }
  assert.throws(() => classifySbyStatus("unknown", "PASS"));
  assert.throws(() => classifySbyStatus("bmc", "__proto__"));
  assert.throws(() => classifySbyStatus("__proto__", "PASS"));
});
