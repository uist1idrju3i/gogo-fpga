const decoderPaths = {
  zstd: "decoders/zstd-decoder.wasm",
  xz: "decoders/xz-decoder.wasm",
};

const decoderPromises = new Map();
let injectedDecoderPromises = new WeakMap();
const wasmPageSize = 65536;
const wasm32MaxBytes = 0xffff_ffff;

function asBytes(value, name) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  throw new TypeError(`${name} must be a Uint8Array or ArrayBuffer`);
}

function checkExpectedSize(expectedSize) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > wasm32MaxBytes) {
    throw new RangeError("expectedSize must be a non-negative WASM32-sized integer");
  }
}

async function instantiateDecoder(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes);
  const { memory, dec_alloc: allocate, dec_free: release, dec_decode: decode } = instance.exports;
  if (
    !(memory instanceof WebAssembly.Memory)
    || typeof allocate !== "function"
    || typeof release !== "function"
    || typeof decode !== "function"
  ) {
    throw new TypeError("Decoder WASM does not export the required ABI");
  }
  if (typeof instance.exports._initialize === "function") {
    instance.exports._initialize();
  }
  return {
    memory,
    allocate,
    release,
    decode,
    initialMemoryBytes: memory.buffer.byteLength,
  };
}

async function loadDecoder(format) {
  const response = await fetch(new URL(decoderPaths[format], import.meta.url));
  if (!response.ok) {
    throw new Error(`Could not load ${format} decoder: HTTP ${response.status}`);
  }
  return instantiateDecoder(await response.arrayBuffer());
}

function getDecoder(format, decoderBytes) {
  if (decoderBytes !== undefined) {
    const key = decoderBytes;
    const bytes = asBytes(decoderBytes, "decoderBytes");
    let promisesByFormat = injectedDecoderPromises.get(key);
    if (!promisesByFormat) {
      promisesByFormat = new Map();
      injectedDecoderPromises.set(key, promisesByFormat);
    }
    let decoderPromise = promisesByFormat.get(format);
    if (!decoderPromise) {
      decoderPromise = instantiateDecoder(bytes);
      promisesByFormat.set(format, decoderPromise);
    }
    return decoderPromise;
  }

  let decoderPromise = decoderPromises.get(format);
  if (!decoderPromise) {
    decoderPromise = loadDecoder(format);
    decoderPromises.set(format, decoderPromise);
  }
  return decoderPromise;
}

function ensureOutputSize(output, expectedSize) {
  if (output.byteLength !== expectedSize) {
    throw new Error(`Decompressed size mismatch: expected ${expectedSize}, got ${output.byteLength}`);
  }
  return output;
}

async function decompressGzip(bytes, expectedSize) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("DecompressionStream is not available");
  }
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  return ensureOutputSize(output, expectedSize);
}

function growMemory(decoder, sourceSize, expectedSize) {
  const requiredBytes = decoder.initialMemoryBytes + sourceSize + expectedSize + wasmPageSize;
  if (requiredBytes > wasm32MaxBytes) {
    throw new RangeError("Compressed input and expected output exceed WASM32 memory limits");
  }
  const currentBytes = decoder.memory.buffer.byteLength;
  if (requiredBytes > currentBytes) {
    const pages = Math.ceil((requiredBytes - currentBytes) / wasmPageSize);
    try {
      decoder.memory.grow(pages);
    } catch (error) {
      throw new Error("Could not grow decoder WASM memory", { cause: error });
    }
  }
}

async function decompressWasm(format, bytes, expectedSize, decoderBytes) {
  const decoder = await getDecoder(format, decoderBytes);
  growMemory(decoder, bytes.byteLength, expectedSize);

  let sourcePointer = 0;
  let destinationPointer = 0;
  try {
    sourcePointer = decoder.allocate(bytes.byteLength);
    if (!sourcePointer) {
      throw new Error("Decoder could not allocate input memory");
    }
    destinationPointer = decoder.allocate(expectedSize);
    if (!destinationPointer) {
      throw new Error("Decoder could not allocate output memory");
    }

    const sourceOffset = sourcePointer >>> 0;
    const destinationOffset = destinationPointer >>> 0;
    const memoryView = new Uint8Array(decoder.memory.buffer);
    memoryView.set(bytes, sourceOffset);

    const written = decoder.decode(
      sourcePointer,
      bytes.byteLength,
      destinationPointer,
      expectedSize,
    );
    if (typeof written !== "bigint" || written < 0n) {
      throw new Error(`${format} decoder failed with code ${written}`);
    }
    if (written !== BigInt(expectedSize)) {
      throw new Error(`Decompressed size mismatch: expected ${expectedSize}, got ${written}`);
    }

    return new Uint8Array(
      decoder.memory.buffer,
      destinationOffset,
      Number(written),
    ).slice();
  } finally {
    if (destinationPointer) {
      decoder.release(destinationPointer);
    }
    if (sourcePointer) {
      decoder.release(sourcePointer);
    }
  }
}

export async function decompress(format, bytes, expectedSize, { decoderBytes } = {}) {
  checkExpectedSize(expectedSize);
  const source = asBytes(bytes, "bytes");
  if (source.byteLength > wasm32MaxBytes) {
    throw new RangeError("Compressed input exceeds WASM32 memory limits");
  }
  if (format === "gzip") {
    return decompressGzip(source, expectedSize);
  }
  if (!Object.hasOwn(decoderPaths, format)) {
    throw new TypeError(`Unsupported compression format: ${format}`);
  }
  return decompressWasm(format, source, expectedSize, decoderBytes);
}

export function releaseDecoders() {
  decoderPromises.clear();
  injectedDecoderPromises = new WeakMap();
}
