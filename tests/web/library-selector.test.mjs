import assert from "node:assert/strict";
import test from "node:test";
import { createLibrarySelector } from "../../web/lib/library-selector.mjs";
import { createBlinkTemplate } from "../../web/lib/templates.mjs";
import { createLibraryFixture, createLibraryProject } from "./library-fixture.mjs";

class Element {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.disabled = false;
    this._text = "";
  }
  append(element) { this.children.push(element); }
  replaceChildren(...children) { this.children = children; this._text = ""; }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  click() { if (!this.disabled) this.listeners.get("click")?.(); }
}

function descendants(element) {
  return [element, ...element.children.flatMap(descendants)];
}

async function harness(t, workspace, catalog, contents, { failCatalog = false, corrupt = false, confirm = true } = {}) {
  const original = Object.fromEntries(["document", "location", "window", "fetch"].map((key) => [key, globalThis[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const requests = [];
  const status = new Element("p");
  const list = new Element("ul");
  const container = { querySelector: (selector) => selector === "[data-library-status]" ? status : list };
  globalThis.document = { baseURI: "https://toolchain.test/nested/index.html", createElement: (tag) => new Element(tag) };
  globalThis.location = { origin: "https://toolchain.test" };
  globalThis.window = { confirm: () => confirm };
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (failCatalog) throw new Error("Catalog unavailable");
    const path = url.pathname.replace("/nested/libraries/", "");
    if (path === "catalog.json") return new Response(JSON.stringify(catalog));
    assert.ok(contents.has(path), `Unexpected asset request: ${url}`);
    return new Response(corrupt ? new Uint8Array() : contents.get(path));
  };
  const events = [];
  let resolveIdle;
  const selector = createLibrarySelector(container, {
    getWorkspace: () => workspace,
    getBoard: () => workspace.project.board,
    canChange: () => true,
    beforeChange: () => events.push("stop"),
    onBusy: (busy) => {
      events.push(busy ? "lock" : "unlock");
      if (!busy) resolveIdle?.();
    },
    onChange: (next, prior) => {
      assert.equal(prior, workspace.project);
      workspace = next;
      events.push("commit");
    },
  });
  await selector.refresh();
  return {
    list, status, requests, events, selector,
    workspace: () => workspace,
    button(id) {
      const item = list.children.find(({ dataset }) => dataset.library === id);
      return descendants(item).find(({ tagName }) => tagName === "button");
    },
    async click(button) {
      const idle = new Promise((resolve) => { resolveIdle = resolve; });
      button.click();
      await idle;
      await selector.refresh(false);
    },
  };
}

test("selector keeps all 22 unverified and unsupported candidates visible with disabled actions and board reasons", async (t) => {
  const { catalog, contents } = await createLibraryFixture();
  catalog.entries = Array.from({ length: 22 }, (_, index) => {
    const entry = structuredClone(catalog.entries[0]);
    entry.id = `candidate-${index}`;
    entry.label = entry.id;
    entry.status = index < 15 ? "unverified" : "unsupported";
    entry.reason = index < 15 ? "動作は未検証です。" : "SystemVerilog は対象外です。";
    for (const asset of entry.license.files) asset.asset = `${entry.id}/${asset.path}`;
    for (const component of entry.components) {
      for (const asset of component.sources) asset.asset = `${entry.id}/${asset.path}`;
      component.dependencies = [];
      for (const board of Object.keys(component.boards)) component.boards[board] = "unverified";
    }
    if (entry.status === "unsupported") entry.components = [];
    return entry;
  });
  const ui = await harness(t, createBlinkTemplate("tangnano1k", "verilog"), catalog, contents);
  assert.equal(ui.list.children.length, 22);
  for (const entry of catalog.entries) assert.equal(ui.button(entry.id).disabled, true);
  assert.match(ui.list.textContent, /Tang Nano 1K: 未検証/);
  assert.match(ui.list.textContent, /Tang Nano 20K: 非対応/);
  assert.match(ui.list.textContent, /SystemVerilog は対象外/);
  assert.equal(ui.requests.length, 1);
});

test("selector labels tested frontend rejection separately from unverified candidates", async (t) => {
  const { catalog, contents } = await createLibraryFixture();
  catalog.entries[0].status = "frontend-unsupported";
  for (const board of Object.keys(catalog.entries[0].components[0].boards)) {
    catalog.entries[0].components[0].boards[board] = "frontend-unsupported";
  }
  const ui = await harness(t, createBlinkTemplate("tangnano1k", "verilog"), catalog, contents);
  assert.match(ui.list.textContent, /フロントエンド非対応/);
  assert.equal(ui.button("primary").disabled, true);
  assert.equal(ui.requests.length, 1);
  assert.deepEqual(ui.events, []);
});

test("selector commits a verified dependency closure only after same-origin static downloads", async (t) => {
  const { catalog, contents } = await createLibraryFixture();
  catalog.entries[0].components[0].parameters = { WIDTH: "8", MODE: '"<script>"' };
  const ui = await harness(t, createBlinkTemplate("tangnano1k", "verilog"), catalog, contents);
  assert.match(ui.list.textContent, /WIDTH = 8/);
  assert.match(ui.list.textContent, /MODE = "<script>"/);
  await ui.click(ui.button("primary"));
  assert.deepEqual(ui.events, ["lock", "stop", "commit", "unlock"]);
  assert.equal(ui.workspace().project.libraries[0].id, "primary");
  assert.ok(ui.workspace().files.has("libraries/dependency/sources/LICENSE"));
  assert.match(ui.list.textContent, /配布カタログと一致/);
  for (const { url, options } of ui.requests) {
    assert.equal(url.origin, "https://toolchain.test");
    assert.ok(url.pathname.startsWith("/nested/libraries/"));
    assert.equal(options.redirect, "error");
  }
});

test("corrupt assets never replace the original workspace and always release the selection lock", async (t) => {
  const { catalog, contents } = await createLibraryFixture();
  const original = createBlinkTemplate("tangnano1k", "verilog");
  const ui = await harness(t, original, catalog, contents, { corrupt: true });
  await ui.click(ui.button("primary"));
  assert.equal(ui.workspace(), original);
  assert.deepEqual(ui.events, ["lock", "stop", "unlock"]);
  assert.match(ui.status.textContent, /ハッシュが一致しません/);
});

test("deprecated components require explicit confirmation before any asset download", async (t) => {
  const { catalog, contents } = await createLibraryFixture();
  catalog.entries[0].deprecated = true;
  const ui = await harness(t, createBlinkTemplate("tangnano1k", "verilog"), catalog, contents, { confirm: false });
  await ui.click(ui.button("primary"));
  assert.equal(ui.requests.length, 1);
  assert.equal(ui.workspace().project.libraries.length, 0);
  assert.match(ui.list.textContent, /保守終了/);
});

test("portable libraries remain removable when the catalog cannot be fetched", async (t) => {
  const installed = await createLibraryProject();
  const ui = await harness(t, installed, installed.catalog, installed.contents, { failCatalog: true });
  assert.match(ui.list.textContent, /配布カタログとの照合なし/);
  const remove = descendants(ui.list).find(({ tagName, textContent }) => tagName === "button" && textContent === "選択を解除");
  await ui.click(remove);
  assert.equal(ui.workspace().project.libraries.length, 0);
  assert.equal([...ui.workspace().files.keys()].some((path) => path.startsWith("libraries/")), false);
});
