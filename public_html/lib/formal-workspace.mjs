import { safePath } from "./verified-assets.mjs";

const MAX_FILES = 4096;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_HEADER = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const shaPattern = /^[0-9a-f]{64}$/;

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function checkedFiles(files) {
  if (!Array.isArray(files) || files.length > MAX_FILES) throw new Error("Invalid workspace file count");
  const checked = new Map();
  let total = 0;
  for (const file of files) {
    if (!safePath(file?.path) || file.path.includes("\0") || file.path.length > 512 ||
        checked.has(file.path) || !(file.bytes instanceof Uint8Array)) {
      throw new Error("Invalid workspace file");
    }
    total += file.bytes.length;
    if (total > MAX_BYTES) throw new Error("Workspace size limit");
    checked.set(file.path, file.bytes);
  }
  for (const path of checked.keys()) {
    const components = path.split("/");
    for (let index = 1; index < components.length; index++) {
      if (checked.has(components.slice(0, index).join("/"))) throw new Error("Conflicting workspace path");
    }
  }
  return checked;
}

function sameBytes(a, b) {
  return a !== undefined && b !== undefined && a.length === b.length &&
    a.every((byte, index) => byte === b[index]);
}

export async function packWorkspaceDelta(before, after) {
  const originals = checkedFiles(before);
  const results = checkedFiles(after);
  const names = [...new Set([...originals.keys(), ...results.keys()])].sort();
  const changes = [];
  const payloads = [];
  let size = 0;
  for (const path of names) {
    const old = originals.get(path);
    const next = results.get(path);
    if (old && next && sameBytes(old, next)) continue;
    if (changes.length >= MAX_FILES) throw new Error("Workspace delta count limit");
    changes.push({ path, beforeSha256: old ? await digest(old) : null,
      afterSha256: next ? await digest(next) : null, length: next?.length ?? 0 });
    if (next) {
      payloads.push(next);
      size += next.length;
      if (size > MAX_BYTES) throw new Error("Workspace delta size limit");
    }
  }
  const header = encoder.encode(JSON.stringify({ version: 1, changes }));
  if (header.length > MAX_HEADER) throw new Error("Workspace delta header limit");
  const frame = new Uint8Array(4 + header.length + size);
  new DataView(frame.buffer).setUint32(0, header.length, true);
  frame.set(header, 4);
  let offset = 4 + header.length;
  for (const bytes of payloads) { frame.set(bytes, offset); offset += bytes.length; }
  return frame;
}

export async function applyWorkspaceDelta(current, frame) {
  const original = checkedFiles(current);
  if (!(frame instanceof Uint8Array) || frame.length < 4 || frame.length > 4 + MAX_HEADER + MAX_BYTES) {
    throw new Error("Invalid workspace delta frame");
  }
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, true);
  if (length > MAX_HEADER || 4 + length > frame.length) throw new Error("Truncated workspace delta header");
  let manifest;
  try { manifest = JSON.parse(decoder.decode(frame.subarray(4, 4 + length))); }
  catch { throw new Error("Invalid workspace delta manifest"); }
  if (manifest?.version !== 1 || !Array.isArray(manifest.changes) || manifest.changes.length > MAX_FILES ||
      Object.keys(manifest).sort().join() !== "changes,version") throw new Error("Invalid workspace delta manifest");
  let offset = 4 + length;
  let previous = "";
  const updated = new Map(original);
  for (const change of manifest.changes) {
    if (!safePath(change?.path) || change.path.includes("\0") || change.path.length > 512 ||
        change.path <= previous || Object.keys(change).sort().join() !== "afterSha256,beforeSha256,length,path" ||
        !(change.beforeSha256 === null || shaPattern.test(change.beforeSha256)) ||
        !(change.afterSha256 === null || shaPattern.test(change.afterSha256)) ||
        !Number.isSafeInteger(change.length) || change.length < 0 || change.length > MAX_BYTES ||
        (change.afterSha256 === null && change.length !== 0) ||
        (change.beforeSha256 === null && change.afterSha256 === null)) throw new Error("Invalid workspace delta entry");
    previous = change.path;
    const existing = original.get(change.path);
    if ((existing ? await digest(existing) : null) !== change.beforeSha256) {
      throw new Error(`Workspace delta conflict: ${change.path}`);
    }
    if (offset + change.length > frame.length) throw new Error("Truncated workspace delta payload");
    if (change.afterSha256 === null) updated.delete(change.path);
    else {
      const bytes = frame.subarray(offset, offset + change.length);
      if (await digest(bytes) !== change.afterSha256) throw new Error(`Workspace delta hash mismatch: ${change.path}`);
      updated.set(change.path, new Uint8Array(bytes));
    }
    offset += change.length;
  }
  if (offset !== frame.length) throw new Error("Unexpected workspace delta bytes");
  const files = [...updated].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, bytes]) => ({ path, bytes }));
  checkedFiles(files);
  return files;
}
