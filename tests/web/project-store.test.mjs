import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryStore, createOpfsStore } from "../../web/lib/project-store.mjs";
import { defaultSimulationSettings } from "../../web/lib/project.mjs";
import { createLibraryProject } from "./library-fixture.mjs";

const project = {
  version: 4,
  libraries: [],
  name: "blink",
  board: "tangnano9k",
  top: "top",
  vhdlStandard: "2008",
  simulation: defaultSimulationSettings(),
  formal: null,
  files: [{ path: "src/top.v" }, { path: "build/top.fs" }],
};

test("memory project store round-trips text and binary files", async () => {
  const store = createMemoryStore();
  const bits = new Uint8Array([0, 1, 2, 255]);
  await store.save(
    project,
    new Map([
      ["src/top.v", "module top; endmodule\n"],
      ["build/top.fs", bits],
    ]),
  );

  bits[0] = 99;
  const loaded = await store.load("blink");
  assert.deepEqual(loaded.project, project);
  assert.equal(loaded.files.get("src/top.v"), "module top; endmodule\n");
  assert.deepEqual(loaded.files.get("build/top.fs"), new Uint8Array([0, 1, 2, 255]));
  assert.deepEqual(await store.listProjects(), ["blink"]);
});

test("memory project store fails closed on corrupt project.json", async () => {
  const store = createMemoryStore({
    records: new Map([["blink", { projectJson: "{", files: new Map() }]]),
  });
  await assert.rejects(store.load("blink"), /project\.json を解析できません/);
});

test("memory project store migrates version 1 projects to default simulation settings", async () => {
  const legacy = { ...project, version: 1 };
  delete legacy.simulation;
  delete legacy.libraries;
  const store = createMemoryStore({
    records: new Map([[
      "blink",
      {
        projectJson: JSON.stringify(legacy),
        files: new Map([
          ["src/top.v", "module top; endmodule\n"],
          ["build/top.fs", new Uint8Array([1])],
        ]),
      },
    ]]),
  });
  const loaded = await store.load("blink");
  assert.equal(loaded.project.version, 4);
  assert.equal(loaded.project.formal, null);
  assert.deepEqual(loaded.project.libraries, []);
  assert.deepEqual(loaded.project.simulation, defaultSimulationSettings());
});

test("memory project store rejects content not declared in the project", async () => {
  const store = createMemoryStore();
  await assert.rejects(
    store.save(project, new Map([["src/top.v", "module top; endmodule"]])),
    /一覧とファイルの内容が一致しません/,
  );
});

function memoryStorage() {
  const state = { failClose: false };
  const missing = () => new DOMException("Missing entry", "NotFoundError");
  function directory() {
    const children = new Map();
    return {
      kind: "directory", children,
      async getDirectoryHandle(name, { create = false } = {}) {
        if (!children.has(name)) {
          if (!create) throw missing();
          children.set(name, directory());
        }
        const child = children.get(name);
        assert.equal(child.kind, "directory");
        return child;
      },
      async getFileHandle(name, { create = false } = {}) {
        if (!children.has(name)) {
          if (!create) throw missing();
          const file = {
            kind: "file", bytes: new Uint8Array(),
            async getFile() { return new Blob([file.bytes]); },
            async createWritable() {
              let pending;
              return {
                async write(content) { pending = typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content); },
                async close() {
                  if (state.failClose) throw new DOMException("Injected write failure", "QuotaExceededError");
                  file.bytes = pending;
                },
                async abort() { pending = null; },
              };
            },
          };
          children.set(name, file);
        }
        const child = children.get(name);
        assert.equal(child.kind, "file");
        return child;
      },
      async *entries() { yield* children.entries(); },
      async removeEntry(name) {
        if (!children.delete(name)) throw missing();
      },
    };
  }
  const root = directory();
  return { root, state, storage: { async getDirectory() { return root; } } };
}

test("memory and OPFS stores reject corrupted snapshots using the same checks as portable ZIPs", async () => {
  const { project, files } = await createLibraryProject();
  const records = new Map();
  const memory = createMemoryStore({ records });
  const mock = memoryStorage();
  const opfs = createOpfsStore(mock.storage);
  for (const store of [memory, opfs]) {
    await store.save(project, files);
    const loaded = await store.load(project.name);
    assert.deepEqual(loaded.project, project);
    assert.deepEqual(loaded.files.get("libraries/primary/sources/LICENSE"), files.get("libraries/primary/sources/LICENSE"));
    const corrupted = new Map(files);
    corrupted.set("libraries/primary/sources/LICENSE", "changed license");
    await assert.rejects(store.save(project, corrupted), /ハッシュ/);
  }
  records.get(project.name).files.set("libraries/primary/sources/LICENSE", "corrupted on disk");
  await assert.rejects(memory.load(project.name), /ハッシュ/);
});

test("OPFS publishes one complete snapshot and leaves the previous snapshot readable after an interrupted save", async () => {
  const mock = memoryStorage();
  const store = createOpfsStore(mock.storage);
  const { project, files } = await createLibraryProject();
  await store.save(project, files);
  mock.state.failClose = true;
  const changed = new Map(files);
  changed.set("src/top.v", "module changed; endmodule\n");
  await assert.rejects(store.save(project, changed), /保存できません/);
  assert.deepEqual((await store.load(project.name)).files.get("src/top.v"), new TextEncoder().encode(files.get("src/top.v")));
  const newProject = { ...project, name: "incomplete" };
  await assert.rejects(store.save(newProject, files), /保存できません/);
  assert.deepEqual(await store.listProjects(), [project.name]);
  await assert.rejects(store.load("incomplete"), /読み込めません/);
});

test("OPFS reads the legacy layout, keeps it usable on a failed migration and replaces it only after commit", async () => {
  const mock = memoryStorage();
  const projects = await mock.root.getDirectoryHandle("projects", { create: true });
  const legacyDirectory = await projects.getDirectoryHandle("legacy", { create: true });
  async function put(directory, path, content) {
    const writable = await (await directory.getFileHandle(path, { create: true })).createWritable();
    await writable.write(content);
    await writable.close();
  }
  const legacy = { ...project, name: "legacy", version: 2, files: [{ path: "top.v" }] };
  delete legacy.libraries;
  delete legacy.formal;
  await put(legacyDirectory, "project.json", JSON.stringify(legacy));
  await put(legacyDirectory, "top.v", "module top; endmodule\n");
  const store = createOpfsStore(mock.storage);
  const migrated = await store.load("legacy");
  assert.equal(migrated.project.version, 4);
  assert.deepEqual(migrated.project.libraries, []);
  assert.equal(migrated.project.formal, null);
  mock.state.failClose = true;
  await assert.rejects(store.save(migrated.project, migrated.files), /保存できません/);
  assert.equal((await store.load("legacy")).project.name, "legacy");
  mock.state.failClose = false;
  await store.save(migrated.project, migrated.files);
  assert.deepEqual([...legacyDirectory.children.keys()], ["workspace.zip"]);
  assert.deepEqual((await store.load("legacy")).project, migrated.project);
});

test("asynchronous snapshot hashing does not expose subsequent caller edits", async () => {
  const { project, files } = await createLibraryProject();
  const store = createMemoryStore();
  const saving = store.save(project, files);
  project.top = "changed";
  files.get("libraries/primary/sources/LICENSE")[0] ^= 1;
  await saving;
  const loaded = await store.load(project.name);
  assert.equal(loaded.project.top, "top");
  assert.notDeepEqual(loaded.files.get("libraries/primary/sources/LICENSE"), files.get("libraries/primary/sources/LICENSE"));
});
