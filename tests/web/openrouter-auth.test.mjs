import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  base64url, randomToken, s256Challenge, beginOpenRouterLogin, callbackParams,
  completeOpenRouterLogin, scrubCallbackUrl, PKCE_STORAGE_KEY,
  createKeyStore, createCredentialStorage, OpenRouterAuthError,
} from "../../web/lib/openrouter-auth.mjs";

function storage() {
  const entries = new Map();
  return { getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, value), removeItem: (key) => entries.delete(key) };
}
const location = { origin: "https://example.test", pathname: "/preview/index.html" };
async function pending() {
  const saved = storage();
  const url = new URL(await beginOpenRouterLogin({ storage: saved, location, crypto: webcrypto, now: () => 1000 }));
  return { saved, state: url.searchParams.get("state"), url };
}

test("S256 exactly matches RFC 7636 Appendix B and uses URL-safe random tokens", async () => {
  assert.equal(await s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", webcrypto),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(base64url(new Uint8Array([251, 255, 255])), "-___");
  const tokens = Array.from({ length: 30 }, () => randomToken(32, webcrypto));
  assert.equal(new Set(tokens).size, 30);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test("begin uses dynamic query-free callback, independent verifier/state and S256", async () => {
  const { saved, state, url } = await pending();
  const record = JSON.parse(saved.getItem(PKCE_STORAGE_KEY));
  assert.equal(url.origin, "https://openrouter.ai");
  assert.equal(url.pathname, "/auth");
  assert.equal(url.searchParams.get("callback_url"), "https://example.test/preview/index.html");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("key_label"), "午後のFPGA");
  assert.equal(record.state, state);
  assert.notEqual(record.verifier, state);
  assert.equal(record.createdAt, 1000);
  assert.equal(url.searchParams.get("code_challenge"), await s256Challenge(record.verifier, webcrypto));
  assert.ok(!url.href.includes(record.verifier));
});

test("successful exchange consumes pending before fetch, uses only OpenRouter and omits credentials/referrer", async () => {
  const { saved, state } = await pending();
  const record = JSON.parse(saved.getItem(PKCE_STORAGE_KEY));
  let count = 0;
  const result = await completeOpenRouterLogin({
    href: `https://example.test/?code=test-code&state=${state}`, storage: saved, now: () => 2000,
    fetchImpl: async (url, options) => {
      count += 1;
      assert.equal(saved.getItem(PKCE_STORAGE_KEY), null);
      assert.equal(url, "https://openrouter.ai/api/v1/auth/keys");
      assert.equal(options.method, "POST");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.referrerPolicy, "no-referrer");
      assert.equal(options.cache, "no-store");
      assert.deepEqual(JSON.parse(options.body), {
        code: "test-code", code_verifier: record.verifier, code_challenge_method: "S256",
      });
      return new Response(JSON.stringify({ key: "sk-or-test" }));
    },
  });
  assert.deepEqual(result, { key: "sk-or-test" });
  assert.equal(count, 1);
  assert.equal(saved.getItem(PKCE_STORAGE_KEY), null);
});

test("invalid, missing, duplicate, denied and expired callbacks fail without a request and clear pending", async (t) => {
  for (const kind of ["missing", "malformed", "state", "no-state", "denied", "no-code", "duplicate", "expired", "future", "invalid-url"]) {
    await t.test(kind, async () => {
      const { saved, state } = await pending();
      let href = `https://example.test/?code=private-code&state=${state}`;
      let now = 2000;
      if (kind === "missing") saved.removeItem(PKCE_STORAGE_KEY);
      if (kind === "malformed") saved.setItem(PKCE_STORAGE_KEY, "not-json-private");
      if (kind === "state") href += "changed";
      if (kind === "no-state") href = "https://example.test/?code=private-code";
      if (kind === "denied") href = "https://example.test/?error=private-code";
      if (kind === "no-code") href = `https://example.test/?state=${state}`;
      if (kind === "duplicate") href += `&state=${state}`;
      if (kind === "expired") now = 601000;
      if (kind === "future") now = 999;
      if (kind === "invalid-url") href = "private-code-not-a-url";
      await assert.rejects(completeOpenRouterLogin({ href, storage: saved, now: () => now,
        fetchImpl: () => assert.fail("Unexpected exchange"),
      }), (error) => error instanceof OpenRouterAuthError && !JSON.stringify(error).includes("private-code"));
      assert.equal(saved.getItem(PKCE_STORAGE_KEY), null);
    });
  }
});

test("HTTP, JSON, network and empty-key errors are sanitized and always clear pending", async (t) => {
  for (const [code, fetchImpl] of [
    ["http_error", async () => new Response("private-key", { status: 403 })],
    ["bad_response", async () => new Response("private-key")],
    ["bad_response", async () => new Response(JSON.stringify({ key: null }))],
    ["bad_response", async () => new Response(JSON.stringify({ key: "  " }))],
    ["network_error", async () => { throw new Error("private-key"); }],
  ]) {
    await t.test(code, async () => {
      const { saved, state } = await pending();
      await assert.rejects(completeOpenRouterLogin({
        href: `https://example.test/?code=private-code&state=${state}`, storage: saved, now: () => 2000, fetchImpl,
      }), (error) => error.code === code && !String(error.stack).includes("private-key") && !String(error.stack).includes("private-code"));
      assert.equal(saved.getItem(PKCE_STORAGE_KEY), null);
    });
  }
});

test("crypto/storage failures clear pending and never expose underlying errors", async () => {
  const saved = storage();
  saved.setItem(PKCE_STORAGE_KEY, "old");
  await assert.rejects(beginOpenRouterLogin({ storage: saved, location, crypto: {
    getRandomValues() { throw new Error("private-key"); },
  } }), { message: "login_unavailable" });
  assert.equal(saved.getItem(PKCE_STORAGE_KEY), null);
  let deleted = false;
  await assert.rejects(completeOpenRouterLogin({ href: "https://example.test", storage: {
    getItem() { throw new Error("private-key"); }, removeItem() { deleted = true; },
  } }), { message: "storage_error" });
  assert.ok(deleted);
});

test("callback URL is scrubbed while preserving unrelated state before exchange", () => {
  assert.equal(callbackParams("https://example.test/?keep=1"), null);
  let rewritten;
  const state = { position: 1 };
  scrubCallbackUrl({ state, replaceState(...args) { rewritten = args; } }, {
    href: "https://example.test/preview/?keep=1&code=private&state=private&error=private&error_description=private#editor",
  });
  assert.deepEqual(rewritten, [state, "", "https://example.test/preview/?keep=1#editor"]);
});

test("keys stay in memory unless explicitly persisted, restore opted-in keys and delete from both stores", async () => {
  let saved = null;
  let writes = 0;
  const credentialStorage = {
    async readExisting() { return saved; },
    async write(key) { writes += 1; saved = key; },
    async remove() { saved = null; },
  };
  const keys = createKeyStore({ credentialStorage });
  await keys.restore();
  assert.equal(keys.key, null);
  keys.set("sk-or-test");
  assert.equal(writes, 0);
  assert.equal(keys.persisted, false);
  await keys.persist();
  assert.equal(writes, 1);
  assert.equal(keys.persisted, true);
  const reloaded = createKeyStore({ credentialStorage });
  await reloaded.restore();
  assert.equal(reloaded.key, "sk-or-test");
  assert.equal(reloaded.persisted, true);
  await reloaded.useMemoryOnly();
  assert.equal(saved, null);
  assert.equal(reloaded.key, "sk-or-test");
  await reloaded.forget();
  assert.equal(reloaded.key, null);
  assert.equal(saved, null);
});

test("storage errors are sanitized, no key cannot be persisted, default IndexedDB is never created", async () => {
  const keys = createKeyStore({ credentialStorage: {
    async readExisting() { throw new Error("private-key"); },
    async write() { throw new Error("private-key"); },
    async remove() { throw new Error("private-key"); },
  } });
  await assert.rejects(keys.restore(), { message: "storage_error" });
  await assert.rejects(keys.persist(), { message: "no_key" });
  keys.set("sk-or-test");
  await assert.rejects(keys.persist(), { message: "storage_error" });
  await assert.rejects(keys.useMemoryOnly(), { message: "storage_error" });
  await assert.rejects(keys.forget(), { message: "storage_error" });
  assert.equal(keys.key, null);
  const adapter = createCredentialStorage({
    async databases() { return []; }, open() { assert.fail("Implicit database creation"); },
  });
  assert.equal(await adapter.readExisting(), null);
  await adapter.remove();
});

test("auth and credential modules never access localStorage, even if access would throw", async () => {
  const old = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Forbidden"); } });
  try {
    const { saved, state } = await pending();
    await completeOpenRouterLogin({ href: `https://example.test/?code=c&state=${state}`, storage: saved,
      now: () => 2000, fetchImpl: async () => new Response('{"key":"sk-or-test"}'),
    });
    const store = createKeyStore({ credentialStorage: { readExisting: async () => null } });
    store.set("sk-or-test");
    await store.restore();
  } finally {
    if (old) Object.defineProperty(globalThis, "localStorage", old);
    else delete globalThis.localStorage;
  }
  for (const file of ["openrouter-auth.mjs", "openrouter-ui.mjs"]) {
    const source = readFileSync(new URL(`../../web/lib/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /localStorage|console\./);
  }
});
