import { strToU8, unzipSync, zipSync } from "fflate";
import { createProjectSnapshot, migrateProject, validatePath, validateProject } from "./project.mjs";

const MAX_ENTRIES = 256;
const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;

function inspectCentralDirectory(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) {
    throw new Error("ZIP ファイルの形式が正しくありません。");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.length - 65_557);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) {
    throw new Error("ZIP ファイルの終端情報がありません。");
  }

  const diskNumber = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const diskEntryCount = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  const commentLength = view.getUint16(endOffset + 20, true);
  if (
    diskNumber !== 0 ||
    directoryDisk !== 0 ||
    diskEntryCount !== entryCount ||
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    endOffset + 22 + commentLength !== bytes.length
  ) {
    throw new Error("ZIP ファイルの構成に対応していません。");
  }
  if (entryCount > MAX_ENTRIES) {
    throw new Error(`ZIP ファイルの項目数は ${MAX_ENTRIES} 件以内にしてください（現在 ${entryCount} 件）。`);
  }
  if (
    directoryOffset + directorySize > endOffset ||
    directoryOffset + directorySize > bytes.length
  ) {
    throw new Error("ZIP ファイルの一覧が不正です。");
  }

  const entries = [];
  const names = new Set();
  let totalBytes = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > directoryOffset + directorySize ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw new Error("ZIP ファイルの一覧が不正です。");
    }
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const flags = view.getUint16(offset + 8, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const entryCommentLength = view.getUint16(offset + 32, true);
    const diskStart = view.getUint16(offset + 34, true);
    if (
      (flags & 1) !== 0 ||
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new Error("ZIP ファイルの項目形式に対応していません。");
    }
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + entryCommentLength;
    if (nextOffset > directoryOffset + directorySize) {
      throw new Error("ZIP ファイルの一覧が不正です。");
    }

    let name;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(nameStart, nameStart + nameLength),
      );
    } catch (error) {
      throw new Error("ZIP ファイルに読み取れないパスがあります。", {
        cause: error,
      });
    }
    if (names.has(name)) {
      throw new Error(`ZIP ファイルに同じ項目が複数あります: ${name}`);
    }
    names.add(name);
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP ファイルの展開後の合計サイズは 16 MiB 以内にしてください（宣言サイズ ${totalBytes} バイト）。`);
    }
    entries.push({ name, compressedSize, uncompressedSize });
    offset = nextOffset;
  }
  if (offset !== directoryOffset + directorySize) {
    throw new Error("ZIP ファイルの一覧が不正です。");
  }
  return entries;
}

export async function exportProjectZip(project, files, { compressionLevel = 6 } = {}) {
  if (!Number.isInteger(compressionLevel) || compressionLevel < 0 || compressionLevel > 9) {
    throw new Error("ZIP の圧縮レベルは 0 から 9 にしてください。");
  }
  const snapshot = await createProjectSnapshot(project, files);
  const entries = Object.create(null);
  entries["project.json"] = strToU8(snapshot.projectJson);
  for (const [path, content] of snapshot.files) {
    entries[path] = typeof content === "string" ? strToU8(content) : content;
  }
  try {
    return zipSync(entries, { level: compressionLevel });
  } catch (error) {
    throw new Error("ZIP ファイルを書き出せません。", { cause: error });
  }
}

export async function importProjectZip(bytes) {
  const entries = inspectCentralDirectory(bytes);
  if (!entries.some(({ name }) => name === "project.json")) {
    throw new Error("ZIP ファイルに project.json がありません。");
  }
  let unpacked;
  try {
    unpacked = unzipSync(bytes);
  } catch (error) {
    throw new Error("ZIP ファイルを展開できません。", { cause: error });
  }

  const names = Object.keys(unpacked);
  if (names.length !== entries.length) {
    throw new Error("ZIP ファイルに重複または不正な項目があります。");
  }
  const declaredSizes = new Map(
    entries.map(({ name, uncompressedSize }) => [name, uncompressedSize]),
  );
  if (names.some((name) => !declaredSizes.has(name))) {
    throw new Error("ZIP ファイルに一覧と異なる項目があります。");
  }
  const actualTotal = names.reduce(
    (total, name) => total + unpacked[name].byteLength,
    0,
  );
  if (actualTotal > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(`ZIP ファイルの展開後の合計サイズは 16 MiB 以内にしてください（展開後 ${actualTotal} バイト）。`);
  }
  if (
    names.some((name) => unpacked[name].byteLength !== declaredSizes.get(name))
  ) {
    throw new Error("ZIP ファイルの展開サイズが一覧と一致しません。");
  }
  if (!Object.hasOwn(unpacked, "project.json")) {
    throw new Error("ZIP ファイルに project.json がありません。");
  }

  let project;
  try {
    project = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(unpacked["project.json"]),
    );
  } catch (error) {
    throw new Error("project.json を読み取れません。", { cause: error });
  }
  project = migrateProject(project);
  const validation = validateProject(project);
  if (!validation.ok) {
    throw new Error(`project.json の内容が不正です: ${validation.errors.join(" ")}`);
  }

  const manifestPaths = new Set();
  for (const { path } of project.files) {
    if (!validatePath(path).ok) {
      throw new Error(`project.json に不正なファイルパスがあります: ${path}`);
    }
    manifestPaths.add(path);
    if (!Object.hasOwn(unpacked, path)) {
      throw new Error(`ZIP ファイルに必要なファイルがありません: ${path}`);
    }
  }
  for (const name of names) {
    if (name === "project.json") continue;
    if (!validatePath(name).ok) {
      throw new Error(`ZIP ファイルのパスが不正です: ${name}`);
    }
    if (!manifestPaths.has(name)) {
      throw new Error(`プロジェクトにないファイルが ZIP に含まれています: ${name}`);
    }
  }

  const snapshot = await createProjectSnapshot(project, new Map(
    project.files.map(({ path }) => [path, unpacked[path]]),
  ));
  return { project: snapshot.project, files: snapshot.files };
}
