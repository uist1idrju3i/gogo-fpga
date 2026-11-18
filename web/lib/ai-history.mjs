export async function compactUserTurn(full) {
  const value = JSON.parse(full);
  async function digest(content) {
    const data = new TextEncoder().encode(content);
    const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
    return { sha256: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join(""), bytes: data.byteLength };
  }
  const files = await Promise.all(value.files.map(async ({ path, content }) => ({ path, ...await digest(content) })));
  const logs = await Promise.all(value.logs.map(async ({ tool, text }) => ({ tool, ...await digest(text) })));
  return JSON.stringify({ ...value, files, logs }, null, 2);
}
