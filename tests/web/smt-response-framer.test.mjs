import assert from "node:assert/strict";
import test from "node:test";
import { createSmtResponseFramer } from "../../web/lib/smt-response-framer.mjs";

const encode = value => new TextEncoder().encode(value);

function frame(chunks, options) {
  const reader = createSmtResponseFramer(options);
  return [...chunks.flatMap(bytes => reader.push(bytes)), ...reader.end()];
}

test("SMT responses retain atoms, nested lists and diagnostic text without interpreting results", () => {
  const input = '; header\r\nsat\n((x #b0011) (a ((as const (Array Int Int)) 0)))\n' +
    'unsat\nunknown\nsuccess\nunsupported\n(error "a; (b) ""quoted""")';
  assert.deepEqual(frame([encode(input)]), ["sat",
    "((x #b0011) (a ((as const (Array Int Int)) 0)))", "unsat", "unknown", "success",
    "unsupported", '(error "a; (b) ""quoted""")']);
});

test("all byte boundaries preserve quoted delimiters, doubled quotes, comments and UTF-8", () => {
  const nested = '(model\n (define-fun |n (;)| () String "日本語"";()") ; ) ignored\n)';
  const echo = '"echo""quoted"';
  const input = encode('; ignored\n' + nested + '\n' + echo + '\n|a b| sat');
  const expected = [nested, echo, "|a b|", "sat"];
  for (let split = 0; split <= input.length; split++) {
    assert.deepEqual(frame([input.slice(0, split), input.slice(split)]), expected);
  }
  assert.deepEqual(frame(Array.from(input, byte => Uint8Array.of(byte))), expected);
});

test("backslashes are opaque in SMT-LIB 2.6 strings, not quote escapes", () => {
  const response = '"a' + String.fromCharCode(92) + '"';
  assert.deepEqual(frame([encode(response + '\nsat\n')]), [response, "sat"]);
  assert.deepEqual(frame([encode('""\n""""\n""""""')]), ['""', '""""', '""""""']);
});

test("atom prefixes and the first half of a doubled quote are withheld until delimited", () => {
  const reader = createSmtResponseFramer();
  assert.deepEqual(reader.push(encode("sa")), []);
  assert.deepEqual(reader.push(encode('t\n"a"')), ["sat"]);
  assert.deepEqual(reader.push(encode('"b"')), []);
  assert.deepEqual(reader.push(encode('\n((x 1))')), ['"a""b"', "((x 1))"]);
  assert.deepEqual(reader.end(), []);
});

test("EOF completes final atoms and strings, and accepts comments without a final newline", () => {
  for (const [input, expected] of [["sat", ["sat"]], ['"x"', ['"x"']],
    ["sat; end", ["sat"]], ["; end", []], [" \r\n\t", []], ["", []]]) {
    assert.deepEqual(frame([encode(input)]), expected);
  }
});

test("incomplete and unbalanced responses fail closed instead of completing a proof", () => {
  for (const invalid of ['(model', '("x"', '(|x|', '"x', '"x""', '|x', '(; comment',
    ')', 'sat)', '(()) )']) {
    assert.throws(() => frame([encode(invalid)]), /SMT response framing/);
  }
});

test("malformed UTF-8 is rejected even in discarded comments and across calls", () => {
  for (const invalid of [[0xff], [0xc0, 0xaf], [0xed, 0xa0, 0x80], [59, 0xff], [0xc3]]) {
    assert.throws(() => frame([Uint8Array.from(invalid)]), /UTF-8/);
  }
  assert.throws(() => frame([Uint8Array.of(0xc3), Uint8Array.of(0x28)]), /UTF-8/);
  assert.deepEqual(frame([encode('\ufeffsat')]), ['\ufeffsat']);
});

test("control bytes are rejected without silently stripping corruption", () => {
  for (const byte of [0, 1, 8, 11, 12, 31, 127]) {
    assert.throws(() => frame([Uint8Array.from([59, byte])]), /control byte/);
  }
});

test("bounded buffers grow for long responses and release callers' mutable input", () => {
  const model = '(model (define-fun x () String "' + "x".repeat(32768) + '"))';
  const input = encode(model);
  const reader = createSmtResponseFramer();
  const first = input.slice(0, 12345);
  assert.deepEqual(reader.push(first), []);
  first.fill(0);
  assert.deepEqual(reader.push(input.slice(12345)), [model]);
  assert.deepEqual(reader.end(), []);
});

test("frame and total limits count raw bytes including multi-byte text and comments", () => {
  const input = encode('(x "日本語")');
  assert.deepEqual(frame([input], { maxFrameBytes: input.length }), ['(x "日本語")']);
  assert.throws(() => frame([input], { maxFrameBytes: input.length - 1 }), /Frame byte limit/);
  assert.deepEqual(frame([encode("a b")], { maxFrameBytes: 1, maxTotalBytes: 3 }), ["a", "b"]);
  assert.throws(() => frame([encode("a b")], { maxTotalBytes: 2 }), /Total byte limit/);
  assert.throws(() => frame([encode("; ignored")], { maxTotalBytes: 8 }), /Total byte limit/);
});

test("depth and response count limits reject excessive lists and flat output", () => {
  assert.deepEqual(frame([encode("((x))")], { maxDepth: 2 }), ["((x))"]);
  assert.throws(() => frame([encode("((x))")], { maxDepth: 1 }), /Nesting depth limit/);
  assert.deepEqual(frame([encode("a b")], { maxFrames: 2 }), ["a", "b"]);
  assert.throws(() => frame([encode("a b")], { maxFrames: 1 }), /Frame count limit/);
});

test("invalid limits and input types cannot leave a reusable parser after failure", () => {
  for (const key of ["maxFrameBytes", "maxTotalBytes", "maxDepth", "maxFrames"]) {
    for (const invalid of [0, -1, 1.5, NaN, Infinity, "2", 8 * 1024 * 1024 + 1]) {
      assert.throws(() => createSmtResponseFramer({ [key]: invalid }), RangeError);
    }
  }
  for (const invalid of ["sat", [], new ArrayBuffer(2), null]) {
    const reader = createSmtResponseFramer();
    assert.throws(() => reader.push(invalid), /Expected Uint8Array/);
    assert.throws(() => reader.push(encode("sat")), /closed/);
    assert.throws(() => reader.end(), /closed/);
  }
  const reader = createSmtResponseFramer();
  reader.end();
  assert.throws(() => reader.end(), /closed/);
  assert.throws(() => reader.push(new Uint8Array()), /closed/);
});
