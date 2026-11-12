import { getBoard } from "./boards.mjs";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function assert(condition, message) {
  if (!condition) throw new Error(`ライブラリー: ${message}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pathIsSafe(path) {
  return typeof path === "string" && path.length <= 512 &&
    /^[A-Za-z0-9._/-]+$/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..");
}

export function validateCompileOptions({ includeDirectories = [], defines = {} } = {}) {
  assert(Array.isArray(includeDirectories) && includeDirectories.every(pathIsSafe), "include パスが不正です。");
  assert(object(defines) && Object.entries(defines).every(([name, value]) =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && ["string", "number"].includes(typeof value) &&
    (typeof value !== "number" || Number.isFinite(value)) &&
    /^[A-Za-z0-9_+*/%<>=!&|^~()'".:-]+$/.test(String(value))), "define の指定が不正です。");
  return { includeDirectories, defines };
}

export function verilogReadCommand(paths, options = {}) {
  const { includeDirectories, defines } = validateCompileOptions(options);
  assert(Array.isArray(paths) && paths.length > 0 && paths.every(pathIsSafe), "Verilog のファイル一覧が不正です。");
  const args = [
    ...includeDirectories.map((path) => `-I${path}`),
    ...Object.entries(defines).map(([name, value]) => `-D${name}=${value}`),
    ...paths.map((path) => JSON.stringify(path)),
  ];
  return `read_verilog ${args.join(" ")}`;
}

export function isLibraryPath(path) {
  return typeof path === "string" && path.startsWith("libraries/");
}

export function librarySnapshotPath(id, component) {
  return `libraries/${id}/snapshots/${component}.json`;
}

function sourcePath(id, path) {
  return `libraries/${id}/sources/${path}`;
}

export function validateLibrarySelections(selections) {
  const errors = [];
  if (!Array.isArray(selections) || selections.length > 128) {
    return ["ライブラリーの選択一覧が不正です。"];
  }
  const seen = new Set();
  for (const selection of selections) {
    if (!object(selection) ||
      Object.keys(selection).some((key) => !["id", "component", "revision", "manifestHash"].includes(key)) ||
      typeof selection.id !== "string" || typeof selection.component !== "string" ||
      !SLUG.test(selection.id) || !SLUG.test(selection.component) ||
      typeof selection.revision !== "string" || typeof selection.manifestHash !== "string" ||
      !SHA.test(selection.revision ?? "") || !HASH.test(selection.manifestHash ?? "")) {
      errors.push("ライブラリーの固定情報が不正です。");
      continue;
    }
    const key = `${selection.id}/${selection.component}`;
    if (seen.has(key)) errors.push(`ライブラリーの選択が重複しています: ${key}`);
    seen.add(key);
  }
  return errors;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

export function libraryManifestText(manifest) {
  return JSON.stringify(canonical(manifest));
}

function bytes(content) {
  assert(typeof content === "string" || content instanceof Uint8Array, "ファイルの内容が不正です。");
  return typeof content === "string" ? encoder.encode(content) : content;
}

export async function libraryHash(content) {
  const digest = await crypto.subtle.digest("SHA-256", bytes(content));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function assetIsValid(asset, id) {
  return object(asset) && pathIsSafe(asset.path) &&
    asset.asset === `${id}/${asset.path}` &&
    Number.isSafeInteger(asset.size) && asset.size >= 0 && HASH.test(asset.sha256 ?? "");
}

function componentAssets(component) {
  return [...component.sources, ...component.data];
}

function indexCatalog(catalog) {
  assert(catalog?.formatVersion === 1 && Array.isArray(catalog.entries) && catalog.entries.length <= 128,
    "カタログの形式が不正です。");
  const entries = new Map();
  const components = new Map();
  for (const entry of catalog.entries) {
    assert(object(entry) && typeof entry.id === "string" && SLUG.test(entry.id) && !entries.has(entry.id), "候補の ID が不正または重複しています。");
    assert(object(entry.source) && SHA.test(entry.source.revision ?? "") &&
      typeof entry.source.url === "string" && /^https:\/\/[^\s]+$/.test(entry.source.url), "取得元の固定情報が不正です。");
    assert(["available", "unverified", "unsupported", "frontend-unsupported"].includes(entry.status) &&
      typeof entry.deprecated === "boolean" && Array.isArray(entry.components) &&
      (entry.status !== "unsupported" || entry.components.length === 0), "候補の状態が不正です。");
    assert(object(entry.license) && typeof entry.license.expression === "string" && entry.license.expression.length > 0 &&
      Array.isArray(entry.license.files) && entry.license.files.length > 0 &&
      entry.license.files.every((asset) => assetIsValid(asset, entry.id)), "ライセンスの記録が不正です。");
    entries.set(entry.id, entry);
    for (const component of entry.components) {
      const key = `${entry.id}/${component?.id}`;
      assert(object(component) && typeof component.id === "string" && SLUG.test(component.id) && !components.has(key) && components.size < 256,
        "部品の ID が不正または重複しています。");
      assert(Array.isArray(component.sources) && component.sources.length > 0 && Array.isArray(component.data) &&
        componentAssets(component).every((asset) => assetIsValid(asset, entry.id)), "部品のファイル一覧が不正です。");
      for (const source of component.sources) {
        assert((source.language === "verilog" && /\.(?:v|vh)$/i.test(source.path) && source.library === undefined) ||
          (source.language === "vhdl" && /\.(?:vhd|vhdl)$/i.test(source.path) &&
            typeof source.library === "string" && /^[A-Za-z](?:[A-Za-z0-9]|_(?=[A-Za-z0-9]))*$/.test(source.library)),
        "HDL または VHDL library の指定が不正です。");
      }
      assert(Array.isArray(component.dependencies) && new Set(component.dependencies).size === component.dependencies.length &&
        component.dependencies.every((ref) => typeof ref === "string" && ref.split("/").length === 2 && ref.split("/").every((part) => SLUG.test(part))),
      "依存の指定が不正です。");
      assert(Array.isArray(component.includeDirectories) && object(component.defines), "include または define の指定がありません。");
      validateCompileOptions(component);
      const parameters = component.parameters === undefined ? {} : component.parameters;
      assert(object(parameters) && Object.entries(parameters).every(([name, value]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string" &&
        value.trim() && value.length <= 1024 && !/[\u0000-\u001f]/.test(value)), "パラメーターの情報が不正です。");
      assert(object(component.boards) && Object.keys(component.boards).length === 4 &&
        Object.entries(component.boards).every(([board, status]) => getBoard(board) &&
          ["confirmed", "capacity-exceeded", "frontend-unsupported", "unverified"].includes(status)), "ボードの確認状態が不正です。");
      components.set(key, { entry, component });
    }
    assert(entry.status !== "frontend-unsupported" || (entry.components.length > 0 &&
      entry.components.every((component) => Object.values(component.boards).every((state) => state === "frontend-unsupported"))),
    "フロントエンド非対応の部品とボードの状態が一致しません。");
  }
  return { entries, components };
}

export function resolveLibraryClosure(catalog, selections, { board, requireConfirmed = true, explicitSelections = selections } = {}) {
  const { entries, components } = indexCatalog(catalog);
  assert(Array.isArray(selections) && selections.length <= 128 &&
    selections.every((selection) => object(selection) && typeof selection.id === "string" && typeof selection.component === "string"), "選択一覧が不正です。");
  assert(Array.isArray(explicitSelections) && explicitSelections.every((selection) => object(selection) && typeof selection.id === "string"), "明示的な選択一覧が不正です。");
  const explicit = new Set(explicitSelections.map((selection) => selection.id));
  const revisions = new Map();
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  function visit(key) {
    if (visited.has(key)) return;
    assert(!visiting.has(key), `依存が循環しています: ${key}`);
    const item = components.get(key);
    assert(item, `部品が見つかりません: ${key}`);
    const { entry, component } = item;
    if (requireConfirmed) {
      assert(entry.status === "available" && component.boards[board] === "confirmed",
        `このボードでは選択できません: ${key} (${component.boards[board] ?? "unknown"})`);
      assert(!entry.deprecated || explicit.has(entry.id), `保守終了の依存を明示的に選択してください: ${entry.id}`);
    }
    visiting.add(key);
    for (const dependency of component.dependencies) visit(dependency);
    visiting.delete(key);
    visited.add(key);
    ordered.push(item);
  }
  for (const selection of selections) {
    const entry = entries.get(selection.id);
    assert(entry && SLUG.test(selection.component ?? ""), "選択した候補が見つかりません。");
    const revision = selection.revision ?? entry.source.revision;
    assert(revision === entry.source.revision && (!revisions.has(entry.id) || revisions.get(entry.id) === revision),
      `固定版が一致しません: ${entry.id}`);
    revisions.set(entry.id, revision);
    visit(`${entry.id}/${selection.component}`);
  }
  const selectedEntries = [];
  for (const { entry, component } of ordered) {
    let selected = selectedEntries.find(({ id }) => id === entry.id);
    if (!selected) {
      selected = { ...entry, components: [] };
      selectedEntries.push(selected);
    }
    selected.components.push(component);
  }
  const defines = new Map();
  for (const { component } of ordered) {
    for (const [name, value] of Object.entries(component.defines)) {
      assert(!defines.has(name) || defines.get(name) === String(value), `define が衝突しています: ${name}`);
      defines.set(name, String(value));
    }
  }
  return { manifest: { formatVersion: 1, entries: selectedEntries }, ordered, defines: Object.fromEntries(defines) };
}

function manifestAssets(manifest) {
  const assets = new Map();
  for (const entry of manifest.entries) {
    for (const asset of [...entry.license.files, ...entry.components.flatMap(componentAssets)]) {
      const path = sourcePath(entry.id, asset.path);
      const prior = assets.get(path);
      assert(!prior || (prior.sha256 === asset.sha256 && prior.size === asset.size), `ファイルが衝突しています: ${path}`);
      assets.set(path, asset);
    }
  }
  return assets;
}

export async function prepareLibrarySelection(catalog, selection, loadAsset, options) {
  const { manifest } = resolveLibraryClosure(catalog, [selection], options);
  const text = libraryManifestText(manifest);
  const entry = manifest.entries.find(({ id }) => id === selection.id);
  const locked = { id: selection.id, component: selection.component, revision: entry.source.revision, manifestHash: await libraryHash(text) };
  const files = new Map([[librarySnapshotPath(locked.id, locked.component), text]]);
  const assets = manifestAssets(manifest);
  assert(assets.size + 2 <= 256, `依存と manifest の項目数は 256 件以内にしてください（現在 ${assets.size + 2} 件）。`);
  const size = [...assets.values()].reduce((total, asset) => total + asset.size, encoder.encode(text).byteLength);
  assert(size <= 16 * 1024 * 1024,
    `依存の展開後の合計サイズは 16 MiB 以内にしてください（現在 ${size} バイト）。`);
  for (const [path, asset] of assets) {
    const loaded = await loadAsset(asset);
    assert(loaded instanceof Uint8Array || loaded instanceof ArrayBuffer, `資材を取得できません: ${path}`);
    const content = new Uint8Array(loaded);
    assert(content.byteLength === asset.size && await libraryHash(content) === asset.sha256, `資材のハッシュが一致しません: ${path}`);
    files.set(path, content);
  }
  return { selection: locked, files };
}

export async function inspectInstalledLibraries(project, files, catalog = null) {
  const selectionErrors = validateLibrarySelections(project.libraries);
  assert(selectionErrors.length === 0, selectionErrors.join(" "));
  const expected = new Map();
  const records = [];
  const mergedEntries = new Map();
  for (const selection of project.libraries) {
    const path = librarySnapshotPath(selection.id, selection.component);
    assert(files.has(path), `固定情報がありません: ${path}`);
    const content = bytes(files.get(path));
    assert(await libraryHash(content) === selection.manifestHash, `固定情報のハッシュが一致しません: ${path}`);
    let snapshot;
    try { snapshot = JSON.parse(decoder.decode(content)); }
    catch (error) { throw new Error(`ライブラリーの固定情報を読めません: ${path}`, { cause: error }); }
    const resolved = resolveLibraryClosure(snapshot, [selection], { requireConfirmed: false });
    assert(libraryManifestText(resolved.manifest) === libraryManifestText(snapshot), `未使用または不完全な依存があります: ${path}`);
    expected.set(path, { size: content.byteLength, sha256: selection.manifestHash });
    for (const [assetPath, asset] of manifestAssets(snapshot)) {
      const prior = expected.get(assetPath);
      assert(!prior || (prior.sha256 === asset.sha256 && prior.size === asset.size), `依存ファイルが衝突しています: ${assetPath}`);
      expected.set(assetPath, asset);
    }
    for (const entry of snapshot.entries) {
      const prior = mergedEntries.get(entry.id);
      assert(!prior || prior.source.revision === entry.source.revision, `異なる固定版が混在しています: ${entry.id}`);
      if (!prior) mergedEntries.set(entry.id, { ...entry, components: [] });
      const merged = mergedEntries.get(entry.id);
      assert(libraryManifestText({ ...merged, components: [] }) === libraryManifestText({ ...entry, components: [] }),
        `取得元またはライセンスの情報が衝突しています: ${entry.id}`);
      for (const component of entry.components) {
        const existing = merged.components.find(({ id }) => id === component.id);
        assert(!existing || libraryManifestText(existing) === libraryManifestText(component), `部品の設定が衝突しています: ${entry.id}/${component.id}`);
        if (!existing) merged.components.push(component);
      }
    }
    let matched = false;
    if (catalog) {
      try {
        const current = resolveLibraryClosure(catalog, [selection], { requireConfirmed: false });
        matched = await libraryHash(libraryManifestText(current.manifest)) === selection.manifestHash;
      } catch { /* An old snapshot remains portable without substituting the current revision. */ }
    }
    records.push({ ...selection, matched, paths: [path, ...manifestAssets(snapshot).keys()] });
  }
  for (const [path, asset] of expected) {
    assert(files.has(path), `依存ファイルがありません: ${path}`);
    const content = bytes(files.get(path));
    assert(content.byteLength === asset.size && await libraryHash(content) === asset.sha256, `依存ファイルのハッシュが一致しません: ${path}`);
  }
  for (const path of files.keys()) assert(!isLibraryPath(path) || expected.has(path), `未登録の依存ファイルがあります: ${path}`);
  const merged = { formatVersion: 1, entries: [...mergedEntries.values()] };
  const resolved = resolveLibraryClosure(merged, project.libraries, { requireConfirmed: false });
  const sources = new Map();
  const dataFiles = new Map();
  const includeDirectories = new Set();
  for (const { entry, component } of resolved.ordered) {
    for (const source of component.sources) {
      const path = sourcePath(entry.id, source.path);
      const prior = sources.get(path);
      assert(!prior || prior.library === source.library, `VHDL library が衝突しています: ${path}`);
      sources.set(path, { ...source, path, role: "source", content: files.get(path) });
    }
    for (const data of component.data) {
      const path = sourcePath(entry.id, data.path);
      dataFiles.set(path, { path, role: "data", content: files.get(path) });
    }
    for (const path of component.includeDirectories) includeDirectories.add(sourcePath(entry.id, path));
  }
  return { records, sources: [...sources.values()], data: [...dataFiles.values()].filter(({ path }) => !sources.has(path)), includeDirectories: [...includeDirectories], defines: resolved.defines };
}
