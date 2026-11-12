const MAX_BYTES = 8 * 1024 * 1024;
const whitespace = byte => byte === 32 || byte === 9 || byte === 10 || byte === 13;
const delimiter = byte => whitespace(byte) || [40, 41, 34, 124, 59].includes(byte);

// Lexical boundaries only: the upstream solver owns SMT-LIB syntax and semantics.
export function createSmtResponseFramer({
  maxFrameBytes = MAX_BYTES,
  maxTotalBytes = MAX_BYTES,
  maxDepth = 512,
  maxFrames = 4096,
} = {}) {
  for (const [value, maximum] of [[maxFrameBytes, MAX_BYTES], [maxTotalBytes, MAX_BYTES],
    [maxDepth, 4096], [maxFrames, 65536]]) {
    if (!Number.isInteger(value) || value < 1 || value > maximum) {
      throw new RangeError("Invalid SMT response framing limit");
    }
  }
  const validator = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let buffer = new Uint8Array(Math.min(1024, maxFrameBytes));
  let length = 0;
  let total = 0;
  let count = 0;
  let depth = 0;
  let kind = null;
  let quote = null;
  let comment = false;
  let closed = false;

  function fail(message) {
    closed = true;
    buffer = null;
    throw new Error(`SMT response framing: ${message}`);
  }

  function append(byte) {
    if (length === maxFrameBytes) fail("Frame byte limit exceeded");
    if (length === buffer.length) {
      const larger = new Uint8Array(Math.min(maxFrameBytes, buffer.length * 2));
      larger.set(buffer);
      buffer = larger;
    }
    buffer[length++] = byte;
  }

  function emit(frames) {
    if (++count > maxFrames) fail("Frame count limit exceeded");
    frames.push(decoder.decode(buffer.subarray(0, length)));
    length = 0;
    kind = null;
    quote = null;
  }

  function requireOpen() {
    if (closed) throw new Error("SMT response framer is closed");
  }

  function push(bytes) {
    requireOpen();
    if (!(bytes instanceof Uint8Array)) fail("Expected Uint8Array input");
    if (bytes.length > maxTotalBytes - total) fail("Total byte limit exceeded");
    total += bytes.length;
    try { validator.decode(bytes, { stream: true }); }
    catch { fail("Invalid UTF-8"); }
    const frames = [];
    for (const byte of bytes) {
      if ((byte < 32 && !whitespace(byte)) || byte === 127) fail("Invalid control byte");
      if (comment) {
        if (kind !== null) append(byte);
        if (byte === 10) comment = false;
        continue;
      }
      if (quote === "string") {
        append(byte);
        if (byte === 34) quote = "string-end";
        continue;
      }
      if (quote === "string-end") {
        if (byte === 34) {
          append(byte);
          quote = "string";
          continue;
        }
        quote = null;
        if (kind === "string") emit(frames);
      }
      if (quote === "symbol") {
        append(byte);
        if (byte === 124) {
          quote = null;
          if (kind === "symbol") emit(frames);
        }
        continue;
      }
      if (kind === "atom") {
        if (!delimiter(byte)) { append(byte); continue; }
        emit(frames);
      }
      if (whitespace(byte)) {
        if (kind !== null) append(byte);
      } else if (byte === 59) {
        if (kind !== null) append(byte);
        comment = true;
      } else if (byte === 41) {
        if (depth === 0) fail("Unexpected closing parenthesis");
        append(byte);
        if (--depth === 0) emit(frames);
      } else if (byte === 40) {
        kind ??= "list";
        append(byte);
        if (++depth > maxDepth) fail("Nesting depth limit exceeded");
      } else if (byte === 34 || byte === 124) {
        quote = byte === 34 ? "string" : "symbol";
        kind ??= quote;
        append(byte);
      } else {
        kind ??= "atom";
        append(byte);
      }
    }
    return Object.freeze(frames);
  }

  function end() {
    requireOpen();
    try { validator.decode(); }
    catch { fail("Incomplete UTF-8"); }
    const frames = [];
    if (quote === "string-end") {
      quote = null;
      if (kind === "string") emit(frames);
    }
    if (quote !== null) fail("Incomplete quoted response");
    if (depth !== 0) fail("Incomplete parenthesized response");
    if (kind === "atom") emit(frames);
    closed = true;
    buffer = null;
    return Object.freeze(frames);
  }

  return Object.freeze({ push, end });
}
