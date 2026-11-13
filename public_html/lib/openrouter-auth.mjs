export const PKCE_STORAGE_KEY = "gogo-fpga.openrouter.pkce";
const ORIGIN = "https://openrouter.ai";

export class OpenRouterAuthError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "OpenRouterAuthError";
    this.code = code;
    if (Number.isInteger(status)) this.status = status;
  }
}

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32, crypto = globalThis.crypto) {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function s256Challenge(verifier, crypto = globalThis.crypto) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

export async function beginOpenRouterLogin({
  crypto = globalThis.crypto, storage = globalThis.sessionStorage,
  location = globalThis.location, now = Date.now,
} = {}) {
  try {
    storage.removeItem(PKCE_STORAGE_KEY);
    const verifier = randomToken(32, crypto);
    const state = randomToken(32, crypto);
    const challenge = await s256Challenge(verifier, crypto);
    const url = new URL("/auth", ORIGIN);
    url.search = new URLSearchParams({
      callback_url: location.origin + location.pathname,
      code_challenge: challenge, code_challenge_method: "S256", state, key_label: "午後のFPGA",
    });
    storage.setItem(PKCE_STORAGE_KEY, JSON.stringify({ verifier, state, createdAt: now() }));
    return url.href;
  } catch {
    try { storage.removeItem(PKCE_STORAGE_KEY); } catch { /* Storage may be unavailable. */ }
    throw new OpenRouterAuthError("login_unavailable");
  }
}

export function callbackParams(href) {
  let params;
  try { params = new URL(href).searchParams; } catch { return null; }
  if (!["code", "state", "error"].some((name) => params.has(name))) return null;
  return {
    code: params.getAll("code").length === 1 ? params.get("code") : null,
    state: params.getAll("state").length === 1 ? params.get("state") : null,
    denied: params.has("error"),
  };
}

export function scrubCallbackUrl(history, location) {
  const url = new URL(location.href);
  for (const name of ["code", "state", "error", "error_description"]) url.searchParams.delete(name);
  history.replaceState(history.state, "", url.href);
}

function statesMatch(expected, actual) {
  if (typeof actual !== "string") return false;
  let different = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index += 1) {
    different |= expected.charCodeAt(index) ^ (actual.charCodeAt(index) || 0);
  }
  return different === 0;
}

export async function completeOpenRouterLogin({
  href, storage = globalThis.sessionStorage, fetchImpl = globalThis.fetch,
  now = Date.now, maxAgeMs = 10 * 60 * 1000,
}) {
  let raw;
  try {
    try { raw = storage.getItem(PKCE_STORAGE_KEY); }
    finally { storage.removeItem(PKCE_STORAGE_KEY); }
  } catch { throw new OpenRouterAuthError("storage_error"); }
  let pending;
  try { pending = JSON.parse(raw); } catch { /* Invalid pending data fails closed. */ }
  if (!pending || !/^[A-Za-z0-9_-]{43}$/.test(pending.verifier)
      || !/^[A-Za-z0-9_-]{43}$/.test(pending.state) || !Number.isSafeInteger(pending.createdAt)) {
    throw new OpenRouterAuthError("no_pending");
  }
  const params = callbackParams(href);
  if (!params || params.denied || !params.code) throw new OpenRouterAuthError("denied");
  if (!statesMatch(pending.state, params.state)) throw new OpenRouterAuthError("state_mismatch");
  const age = now() - pending.createdAt;
  if (!Number.isFinite(age) || age < 0 || age >= maxAgeMs) throw new OpenRouterAuthError("expired");
  let response;
  try {
    response = await fetchImpl(`${ORIGIN}/api/v1/auth/keys`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: params.code, code_verifier: pending.verifier, code_challenge_method: "S256" }),
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", cache: "no-store",
    });
  } catch { throw new OpenRouterAuthError("network_error"); }
  if (!response.ok) throw new OpenRouterAuthError("http_error", response.status);
  let body;
  try { body = await response.json(); } catch { throw new OpenRouterAuthError("bad_response"); }
  if (typeof body?.key !== "string" || !body.key.trim()) throw new OpenRouterAuthError("bad_response");
  return { key: body.key };
}

function validKey(key) { return typeof key === "string" && key.trim().length > 0; }

export function createCredentialStorage(indexedDB = globalThis.indexedDB) {
  const databaseName = "gogo-fpga-ai";
  async function exists() {
    if (!indexedDB) return false;
    if (!indexedDB.databases) throw new OpenRouterAuthError("storage_error");
    return (await indexedDB.databases()).some(({ name }) => name === databaseName);
  }
  function transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const fail = () => reject(new OpenRouterAuthError("storage_error"));
      const opening = indexedDB.open(databaseName, 1);
      let blocked = false;
      opening.onblocked = () => { blocked = true; fail(); };
      opening.onerror = fail;
      opening.onupgradeneeded = () => opening.result.createObjectStore("credentials");
      opening.onsuccess = () => {
        const db = opening.result;
        if (blocked) { db.close(); return; }
        db.onversionchange = () => db.close();
        try {
          const tx = db.transaction("credentials", mode);
          const request = action(tx.objectStore("credentials"));
          tx.oncomplete = () => { db.close(); resolve(request.result); };
          tx.onabort = tx.onerror = () => { db.close(); fail(); };
        } catch { db.close(); fail(); }
      };
    });
  }
  return {
    async readExisting() {
      if (!await exists()) return null;
      return transaction("readonly", (store) => store.get("openrouter"));
    },
    write(key) { return transaction("readwrite", (store) => store.put(key, "openrouter")); },
    async remove() {
      if (!await exists()) return;
      await transaction("readwrite", (store) => store.delete("openrouter"));
    },
  };
}

export function createKeyStore({ memory = { key: null }, credentialStorage = createCredentialStorage() } = {}) {
  let persisted = false;
  return {
    get key() { return memory.key; },
    get persisted() { return persisted; },
    set(key) {
      if (!validKey(key)) throw new OpenRouterAuthError("bad_response");
      memory.key = key;
      persisted = false;
    },
    async restore() {
      try {
        const key = await credentialStorage.readExisting();
        if (validKey(key)) { memory.key = key; persisted = true; }
      } catch { throw new OpenRouterAuthError("storage_error"); }
    },
    async persist() {
      if (!validKey(memory.key)) throw new OpenRouterAuthError("no_key");
      try { await credentialStorage.write(memory.key); persisted = true; }
      catch { throw new OpenRouterAuthError("storage_error"); }
    },
    async useMemoryOnly() {
      try { await credentialStorage.remove(); persisted = false; }
      catch { throw new OpenRouterAuthError("storage_error"); }
    },
    async forget() {
      memory.key = null;
      try { await credentialStorage.remove(); persisted = false; }
      catch { throw new OpenRouterAuthError("storage_error"); }
    },
  };
}
