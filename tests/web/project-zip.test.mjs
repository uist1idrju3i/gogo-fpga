import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { createLibraryProject } from "./library-fixture.mjs";
import {
  exportProjectZip,
  importProjectZip,
} from "../../web/lib/project-zip.mjs";

const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

function makeProject() {
  const template = createBlinkTemplate("tangnano9k", "verilog");
  template.project.name = "zip-project";
  template.project.files.push({ path: "artifacts/bitstream.fs" });
  template.files.set(
    "artifacts/bitstream.fs",
    new Uint8Array([0x00, 0xff, 0x80, 0x0a, 0x00, 0x5a]),
  );
  return template;
}

function makeZip(entries) {
  const zipEntries = Object.create(null);
  for (const [path, content] of Object.entries(entries)) {
    zipEntries[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zipEntries);
}

function manifestEntries(project, fileEntries = {}) {
  return {
    "project.json": strToU8(JSON.stringify(project)),
    ...fileEntries,
  };
}

async function expectJapaneseFailure(bytes, expectedPattern) {
  await assert.rejects(
    () => importProjectZip(bytes),
    (error) => {
      assert.match(error.message, expectedPattern);
      assert.match(error.message, /[ぁ-んァ-ヶ\u4e00-\u9fff]/u);
      return true;
    },
  );
}

function renameCentralDirectoryEntry(bytes, oldName, newName) {
  assert.equal(oldName.length, newName.length);
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  const signature = 0x02014b50;
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    if (view.getUint32(offset, true) !== signature) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameOffset = offset + 46;
    const name = new TextDecoder().decode(
      copy.subarray(nameOffset, nameOffset + nameLength),
    );
    if (name === oldName) {
      copy.set(strToU8(newName), nameOffset);
      return copy;
    }
    offset += nameLength + extraLength + commentLength;
  }
  throw new Error("中央ディレクトリーの項目が見つかりません。");
}

function setCentralDirectorySize(bytes, name, uncompressedSize) {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  const signature = 0x02014b50;
  for (let offset = 0; offset + 46 <= copy.length; offset += 1) {
    if (view.getUint32(offset, true) !== signature) continue;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameOffset = offset + 46;
    const entryName = new TextDecoder().decode(
      copy.subarray(nameOffset, nameOffset + nameLength),
    );
    if (entryName === name) {
      view.setUint32(offset + 24, uncompressedSize, true);
      return copy;
    }
    offset += nameLength + extraLength + commentLength;
  }
  throw new Error("中央ディレクトリーの項目が見つかりません。");
}

test("project ZIP preserves text and binary file bytes", async () => {
  const { project, files } = makeProject();
  const imported = await importProjectZip(await exportProjectZip(project, files));

  assert.deepEqual(imported.project, project);
  for (const [path, content] of files) {
    const expected = typeof content === "string" ? strToU8(content) : content;
    assert.deepEqual(imported.files.get(path), expected, path);
  }
});

test("project ZIP preserves the selected VHDL standard", async () => {
  const { project, files } = makeProject();
  project.vhdlStandard = "2019";
  const imported = await importProjectZip(await exportProjectZip(project, files));
  assert.equal(imported.project.vhdlStandard, "2019");
});

test("project ZIP round-trips simulation settings", async () => {
  const { project, files } = makeProject();
  project.simulation = {
    top: "custom_tb",
    files: ["src/top.v"],
    timeLimitSeconds: 35,
  };
  const imported = await importProjectZip(await exportProjectZip(project, files));
  assert.deepEqual(imported.project.simulation, project.simulation);
});

test("legacy project ZIPs default the VHDL standard to 2008", async () => {
  const template = createBlinkTemplate("tangnano9k", "verilog");
  delete template.project.vhdlStandard;
  const imported = await importProjectZip(
    makeZip(manifestEntries(
      template.project,
      Object.fromEntries(
        [...template.files].map(([path, content]) => [path, strToU8(content)]),
      ),
    )),
  );
  assert.equal(imported.project.vhdlStandard, "2008");
});

test("legacy project ZIPs migrate to default simulation settings", async () => {
  const template = createBlinkTemplate("tangnano9k", "verilog");
  template.project.version = 1;
  delete template.project.simulation;
  delete template.project.libraries;
  delete template.project.formal;
  const imported = await importProjectZip(
    makeZip(manifestEntries(
      template.project,
      Object.fromEntries(
        [...template.files].map(([path, content]) => [path, strToU8(content)]),
      ),
    )),
  );
  assert.equal(imported.project.version, 4);
  assert.deepEqual(imported.project.libraries, []);
  assert.equal(imported.project.formal, null);
  assert.deepEqual(imported.project.simulation, {
    top: "top_tb",
    files: null,
    timeLimitSeconds: 10,
  });
});

test("project ZIP export rejects a file map that differs from the manifest", async () => {
  const { project, files } = makeProject();
  files.delete("src/top.v");
  await assert.rejects(
    () => exportProjectZip(project, files),
    /プロジェクトの一覧とファイルの内容が一致しません/,
  );
});

test("project ZIP export rejects archives outside the supported limits", async () => {
  const oversizedProject = makeProject();
  for (
    let index = 0;
    oversizedProject.project.files.length < 256;
    index += 1
  ) {
    const path = `extra/file-${index}.v`;
    oversizedProject.project.files.push({ path });
    oversizedProject.files.set(path, "");
  }
  await assert.rejects(
    () => exportProjectZip(oversizedProject.project, oversizedProject.files),
    /項目数は 256 件以内/,
  );

  const oversizedFile = makeProject();
  oversizedFile.project.files.push({ path: "large.v" });
  oversizedFile.files.set("large.v", new Uint8Array(MAX_UNCOMPRESSED_BYTES));
  await assert.rejects(
    () => exportProjectZip(oversizedFile.project, oversizedFile.files),
    /合計サイズは 16 MiB 以内/,
  );
});

test("project ZIP import rejects a missing project.json", async () => {
  await expectJapaneseFailure(makeZip({ "src/top.v": "module top; endmodule" }), /project\.json/);
});

test("project ZIP import rejects malformed project.json", async () => {
  await expectJapaneseFailure(makeZip({ "project.json": "{" }), /project\.json/);
});

test("project ZIP import rejects an invalid project schema", async () => {
  const { project } = makeProject();
  project.version = 99;
  await expectJapaneseFailure(makeZip(manifestEntries(project)), /project\.json/);
});

test("project ZIP import rejects an invalid file path", async () => {
  const { project, files } = makeProject();
  const entries = manifestEntries(
    project,
    Object.fromEntries([...files].map(([path, value]) => [path, value])),
  );
  entries["bad-path"] = strToU8("invalid");
  await expectJapaneseFailure(makeZip(entries), /パスが不正/);
});

test("project ZIP import rejects unmanifested entries", async () => {
  const { project, files } = makeProject();
  const entries = manifestEntries(
    project,
    Object.fromEntries([...files].map(([path, value]) => [path, value])),
  );
  entries["src/extra.v"] = strToU8("module extra; endmodule");
  await expectJapaneseFailure(makeZip(entries), /プロジェクトにないファイル/);
});

test("project ZIP import rejects manifest files that are missing", async () => {
  const { project } = makeProject();
  await expectJapaneseFailure(makeZip(manifestEntries(project)), /必要なファイルがありません/);
});

test("project ZIP import rejects duplicate entries", async () => {
  const duplicateZip = makeZip({
    "project.json": "{}",
    "duplicate/a.v": "module a;",
    "duplicate/b.v": "module b;",
  });
  await expectJapaneseFailure(
    renameCentralDirectoryEntry(duplicateZip, "duplicate/b.v", "duplicate/a.v"),
    /同じ項目が複数/,
  );
});

test("project ZIP import rejects traversal paths", async () => {
  const { project, files } = makeProject();
  const entries = manifestEntries(
    project,
    Object.fromEntries([...files].map(([path, value]) => [path, value])),
  );
  entries["../escape.v"] = strToU8("module escape; endmodule");
  await expectJapaneseFailure(makeZip(entries), /パスが不正/);
});

test("project ZIP import rejects more than 256 entries", async () => {
  const entries = Object.create(null);
  entries["project.json"] = strToU8("{}");
  for (let index = 0; index < 256; index += 1) {
    entries[`extra/file-${index}.v`] = strToU8("");
  }
  await expectJapaneseFailure(zipSync(entries), /項目数は 256 件以内/);
});

test("project ZIP import rejects declared uncompressed size over 16 MiB", async () => {
  const { project } = makeProject();
  project.files.push({ path: "large.v" });
  const bytes = new Uint8Array(MAX_UNCOMPRESSED_BYTES + 1);
  const zip = makeZip({ ...manifestEntries(project), "large.v": bytes });
  await expectJapaneseFailure(zip, /合計サイズは 16 MiB 以内/);
});

test("project ZIP import rejects actual uncompressed size over 16 MiB", async () => {
  const { project } = makeProject();
  project.files.push({ path: "large.v" });
  const bytes = new Uint8Array(MAX_UNCOMPRESSED_BYTES + 1);
  const entries = manifestEntries(project);
  entries["large.v"] = bytes;
  const zip = zipSync(entries, { level: 0 });
  const forgedSize = setCentralDirectorySize(zip, "large.v", 1);
  await expectJapaneseFailure(forgedSize, /合計サイズ|展開/);
});

test("portable ZIP preserves the dependency closure, original licenses, fixed revision and lock hashes", async () => {
  const { project, files } = await createLibraryProject();
  const imported = await importProjectZip(await exportProjectZip(project, files));
  assert.deepEqual(imported.project, project);
  for (const [path, content] of files) {
    assert.deepEqual(imported.files.get(path), typeof content === "string" ? strToU8(content) : content, path);
  }
});

test("portable ZIP import and export reject corrupted or unregistered dependencies", async () => {
  const { project, files } = await createLibraryProject();
  const path = "libraries/dependency/sources/rtl/unit.v";
  const entries = manifestEntries(project, Object.fromEntries(files));
  entries[path] = "module tampered; endmodule";
  await expectJapaneseFailure(makeZip(entries), /ハッシュ/);
  files.set(path, entries[path]);
  await assert.rejects(exportProjectZip(project, files), /ハッシュ/);
});

test("version 2 ZIPs gain an empty library selection without changing simulation settings", async () => {
  const { project, files } = makeProject();
  project.version = 2;
  delete project.libraries;
  project.simulation.timeLimitSeconds = 25;
  const imported = await importProjectZip(makeZip(manifestEntries(project, Object.fromEntries(files))));
  assert.equal(imported.project.version, 4);
  assert.deepEqual(imported.project.libraries, []);
  assert.equal(imported.project.formal, null);
  assert.equal(imported.project.simulation.timeLimitSeconds, 25);
});
