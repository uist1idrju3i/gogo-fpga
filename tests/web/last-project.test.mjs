import assert from "node:assert/strict";
import test from "node:test";
import { lastProjectName, rememberProject } from "../../web/lib/last-project.mjs";

function storage() {
  const values = new Map();
  return () => ({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
}

test("last project restores selection and follows activation after a rename", () => {
  const saved = storage();
  rememberProject("z", saved);
  assert.equal(lastProjectName(["a", "z"], saved), "z");
  rememberProject("renamed", saved);
  assert.equal(lastProjectName(["a", "renamed"], saved), "renamed");
});

test("last project key cannot collide with per-project tab state", () => {
  const values = new Map([["toolchain.ide.settings", '{"openTabs":[]}']]);
  const saved = () => ({ getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });
  rememberProject("settings", saved);
  assert.equal(values.get("toolchain.ide.settings"), '{"openTabs":[]}');
  assert.equal(lastProjectName(["a", "settings"], saved), "settings");
});

test("missing, deleted and renamed-away selections fall back; empty workspace clears selection", () => {
  const saved = storage();
  assert.equal(lastProjectName(["a", "z"], saved), "a");
  rememberProject("deleted", saved);
  assert.equal(lastProjectName(["a", "z"], saved), "a");
  assert.equal(lastProjectName([], saved), null);
  rememberProject(null, saved);
  assert.equal(lastProjectName(["a", "deleted"], saved), "a");
});

test("denied storage access, reads, writes and removal do not prevent opening projects", () => {
  const deny = () => { throw new Error("denied"); };
  for (const saved of [deny, () => ({ getItem: deny, setItem: deny, removeItem: deny })]) {
    assert.equal(lastProjectName(["a", "z"], saved), "a");
    assert.equal(lastProjectName([], saved), null);
    assert.doesNotThrow(() => rememberProject("z", saved));
    assert.doesNotThrow(() => rememberProject(null, saved));
  }
});
