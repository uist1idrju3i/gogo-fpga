import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { publicationView, loadPublicationInfo } from "../../web/lib/publication-info.mjs";

const info = { sha: "a".repeat(40), short_sha: "aaaaaaa", commit_date: "2026-11-13T09:00:00Z",
  run_url: "https://github.com/uist1idrju3i/gogo-fpga/actions/runs/7" };

test("publication view identifies the approved source, not the latest main", () => {
  const view = publicationView(info);
  assert.equal(view.label, "公開版 aaaaaaa");
  assert.equal(view.href, `https://github.com/uist1idrju3i/gogo-fpga/commit/${info.sha}`);
  assert.ok(view.title.includes(info.sha));
  assert.ok(view.title.includes(info.commit_date));
  assert.ok(view.title.includes(info.run_url));
});

test("missing, malformed and unsafe metadata stay in development mode", () => {
  for (const bad of [null, {}, [], { ...info, sha: `${info.sha}\n` },
    { ...info, sha: "<script>" }, { ...info, short_sha: "bbbbbbb" },
    { ...info, commit_date: "2026-02-30T09:00:00Z" }, { ...info, commit_date: "bad" },
    { ...info, commit_date: {} }, { ...info, run_url: { toString: null } },
    { ...info, run_url: "https://example.com/" }]) {
    assert.deepEqual(publicationView(bad), { label: "開発版" });
  }
});

test("metadata fetch stays same-origin, refuses redirects and tolerates errors", async () => {
  assert.equal((await loadPublicationInfo(async (url, options) => {
    assert.equal(url.pathname.endsWith("/publication-info.json"), true);
    assert.equal(options.mode, "same-origin");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.equal(options.cache, "no-cache");
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => info };
  })).label, "公開版 aaaaaaa");
  for (const fetcher of [async () => ({ ok: false }), async () => { throw new Error("offline"); },
    async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } })]) {
    assert.deepEqual(await loadPublicationInfo(fetcher), { label: "開発版" });
  }
});

test("development artifact contains no source commit", () => {
  assert.equal(readFileSync(new URL("../../web/publication-info.json", import.meta.url), "utf8"), "null\n");
  assert.equal(readFileSync(new URL("../../public_html/publication-info.json", import.meta.url), "utf8"), "null\n");
  const manifest = JSON.parse(readFileSync(new URL("../../public_html/build-info.json", import.meta.url), "utf8"));
  assert.match(manifest.artifacts["openFPGALoader.wasm"], /^[0-9a-f]{64}$/);
});
