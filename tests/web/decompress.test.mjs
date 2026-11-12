import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { decompress, releaseDecoders } from "../../web/lib/decompress.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const decoderBytes = {
  zstd: readFileSync(resolve(repoRoot, "build/wasi/decoders/zstd-decoder.wasm")),
  xz: readFileSync(resolve(repoRoot, "build/wasi/decoders/xz-decoder.wasm")),
};
const synthetic = Uint8Array.from(
  { length: 12 * 1024 },
  (_, index) => (index * 31 + (index >>> 4)) & 0xff,
);
const realAsset = readFileSync(resolve(repoRoot, "dist/synth/manifest.json"));

function compress(format, bytes) {
  if (format === "gzip") {
    return gzipSync(bytes, { level: 9 });
  }
  const command = format === "zstd" ? "zstd" : "xz";
  const args = format === "zstd" ? ["-19", "--stdout"] : ["-9e", "--stdout"];
  return execFileSync(command, args, { input: bytes });
}

for (const format of ["gzip", "zstd", "xz"]) {
  const wasmBytes = decoderBytes[format];
  const compressedSynthetic = compress(format, synthetic);
  const injection = wasmBytes === undefined ? undefined : { decoderBytes: wasmBytes };

  test(`${format} round-trips synthetic data and a real asset`, async () => {
    for (const input of [synthetic, realAsset]) {
      const compressed = compress(format, input);
      const output = await decompress(format, compressed, input.byteLength, injection);
      assert.deepEqual(output, Uint8Array.from(input));
      assert.notStrictEqual(output, input);
      assert.notStrictEqual(output.buffer, input.buffer);
    }
  });

  test(`${format} detects a flipped compressed byte`, async (t) => {
    const corrupted = new Uint8Array(compressedSynthetic);
    corrupted[Math.floor(corrupted.byteLength / 2)] ^= 1;

    let output;
    try {
      output = await decompress(format, corrupted, synthetic.byteLength, injection);
    } catch {
      t.diagnostic("middle-byte flip rejected by decoder");
      return;
    }

    assert.notDeepEqual(output, synthetic);
    t.diagnostic("middle-byte flip decoded to mismatching bytes");
  });

  test(`${format} rejects truncated input`, async () => {
    const truncated = compressedSynthetic.subarray(0, compressedSynthetic.byteLength - 1);
    await assert.rejects(
      decompress(format, truncated, synthetic.byteLength, injection),
    );
  });

  test(`${format} rejects incorrect output sizes`, async () => {
    await assert.rejects(
      decompress(format, compressedSynthetic, synthetic.byteLength + 1, injection),
    );
    await assert.rejects(
      decompress(format, compressedSynthetic, synthetic.byteLength - 1, injection),
    );
  });
}

test("zstd decodes concatenated frames", async () => {
  const first = synthetic.subarray(0, 4096);
  const second = synthetic.subarray(4096);
  const concatenated = Buffer.concat([compress("zstd", first), compress("zstd", second)]);
  const output = await decompress(
    "zstd",
    concatenated,
    first.byteLength + second.byteLength,
    { decoderBytes: decoderBytes.zstd },
  );
  assert.deepEqual(output, synthetic);
});

test("releaseDecoders drops cached decoder instances", async () => {
  const compressed = compress("zstd", synthetic);
  const injection = { decoderBytes: decoderBytes.zstd };
  assert.deepEqual(
    await decompress("zstd", compressed, synthetic.byteLength, injection),
    synthetic,
  );
  releaseDecoders();
  assert.deepEqual(
    await decompress("zstd", compressed, synthetic.byteLength, injection),
    synthetic,
  );
});
