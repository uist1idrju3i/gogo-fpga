import { createHash } from "node:crypto";

export async function storedFile(page, projectName, path) {
  const bytes = await page.evaluate(async ({ name, path }) => {
    const { createOpfsStore } = await import("/lib/project-store.mjs");
    const { files } = await createOpfsStore(navigator.storage).load(name);
    const contents = files.get(path);
    if (!(contents instanceof Uint8Array)) {
      throw new Error(`Stored project file is missing or invalid: ${path}`);
    }
    return Array.from(contents);
  }, { name: projectName, path });
  return Buffer.from(bytes);
}

export async function storedFsDigest(page, projectName) {
  const bytes = await storedFile(page, projectName, "build/top.fs");
  return {
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
