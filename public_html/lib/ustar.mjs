import { setTreeEntry } from "./wasi-p1.mjs";

const BLOCK_SIZE = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function decodeField(bytes, start, end) {
  let limit = start;
  while (limit < end && bytes[limit] !== 0) limit += 1;
  return utf8.decode(bytes.subarray(start, limit));
}

function parseOctal(bytes, start, end, label) {
  const text = decodeField(bytes, start, end).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Invalid ustar ${label}`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Invalid ustar ${label}`);
  }
  return value;
}

function isZeroBlock(bytes, start) {
  for (let index = start; index < start + BLOCK_SIZE; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function validateHeader(bytes, start) {
  if (decodeField(bytes, start + 257, start + 263) !== "ustar") {
    throw new Error("Unsupported ustar header format");
  }
  const expected = parseOctal(bytes, start + 148, start + 156, "checksum");
  let checksum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) {
    checksum += index >= 148 && index < 156 ? 32 : bytes[start + index];
  }
  if (checksum !== expected) {
    throw new Error("Invalid ustar header checksum");
  }
}

function entryPath(bytes, start) {
  const name = decodeField(bytes, start, start + 100);
  const prefix = decodeField(bytes, start + 345, start + 500);
  const path = prefix ? `${prefix}/${name}` : name;
  const parts = path.split("/");
  if (parts.at(-1) === "") parts.pop();
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Invalid ustar entry path");
  }
  return parts;
}

function directoryAt(root, parts, create) {
  let current = root;
  for (const part of parts) {
    const next = Object.hasOwn(current, part) ? current[part] : undefined;
    if (next === undefined) {
      if (!create) return null;
      setTreeEntry(current, part, {});
    } else if (next === null || typeof next !== "object" || next instanceof Uint8Array) {
      throw new Error("Conflicting ustar entry paths");
    }
    current = current[part];
  }
  return current;
}

export function readUstar(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength === 0 || bytes.byteLength % BLOCK_SIZE !== 0) {
    throw new Error("Invalid ustar archive length");
  }

  const root = {};
  const seen = new Set();
  let offset = 0;
  let ended = false;
  while (offset + BLOCK_SIZE <= bytes.byteLength) {
    if (isZeroBlock(bytes, offset)) {
      if (
        offset + BLOCK_SIZE * 2 > bytes.byteLength ||
        !isZeroBlock(bytes, offset + BLOCK_SIZE)
      ) {
        throw new Error("Invalid ustar end marker");
      }
      for (let index = offset + BLOCK_SIZE * 2; index < bytes.byteLength; index += 1) {
        if (bytes[index] !== 0) throw new Error("Data follows the ustar end marker");
      }
      ended = true;
      break;
    }

    validateHeader(bytes, offset);
    const parts = entryPath(bytes, offset);
    const path = parts.join("/");
    if (seen.has(path)) throw new Error("Duplicate ustar entry path");
    seen.add(path);

    const type = bytes[offset + 156];
    const size = parseOctal(bytes, offset + 124, offset + 136, "file size");
    const dataStart = offset + BLOCK_SIZE;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (dataStart + paddedSize > bytes.byteLength) {
      throw new Error("Truncated ustar entry");
    }

    const parent = directoryAt(root, parts.slice(0, -1), true);
    const name = parts.at(-1);
    if (type === 0 || type === 48) {
      if (Object.hasOwn(parent, name)) throw new Error("Conflicting ustar entry paths");
      setTreeEntry(parent, name, bytes.slice(dataStart, dataStart + size));
    } else if (type === 53) {
      if (size !== 0) throw new Error("Invalid ustar directory size");
      if (!Object.hasOwn(parent, name)) setTreeEntry(parent, name, {});
      else if (
        parent[name] === null ||
        typeof parent[name] !== "object" ||
        parent[name] instanceof Uint8Array
      ) {
        throw new Error("Conflicting ustar entry paths");
      }
    } else {
      throw new Error("Unsupported ustar entry type");
    }
    offset = dataStart + paddedSize;
  }

  if (!ended) throw new Error("Missing ustar end marker");
  return root;
}
