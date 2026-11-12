import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = path.resolve(import.meta.dirname, "../..");
const [version, commit] = execFileSync("python3", [".github/scripts/check-pins.py", "yosys-pin"], {
  cwd: root, encoding: "utf8",
}).trim().split("\t");
assert.equal(commit, execFileSync("git", ["rev-parse", "HEAD:vendor/yosys"], { cwd: root, encoding: "utf8" }).trim());
export const creatorPrefix = `Yosys ${version.replace(/^v/, "")} (git sha1 ${commit.slice(0, 9)}`;
export const nativeYosysSharePath = path.join(root, "build/native/share");

export function assertYosysCreator(creator) {
  const prefixes = ["", "+", "+post"].flatMap((suffix) =>
    [commit.slice(0, 9), commit].map((revision) => `Yosys ${version.replace(/^v/, "")}${suffix} (git sha1 ${revision}, `));
  assert.ok(typeof creator === "string" && prefixes.some((prefix) => creator.startsWith(prefix)), `Unexpected Yosys creator: ${creator}`);
}

export function runNativeYosys(workdir, command) {
  const started = performance.now();
  const result = spawnSync(path.join(root, "build/native/yosys"), ["-q", "-p", command], {
    cwd: workdir, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  const elapsed = performance.now() - started;
  writeFileSync(path.join(workdir, "native-yosys.stdout"), result.stdout ?? "");
  writeFileSync(path.join(workdir, "native-yosys.stderr"), result.stderr ?? "");
  assert.equal(result.status, 0, `Native Yosys failed:\n${result.stderr}\n${result.error ?? ""}`);
  return elapsed;
}

export function assertYosysParity(nativeDocument, wasiDocument) {
  const native = structuredClone(nativeDocument);
  const wasi = structuredClone(wasiDocument);
  let substitutions = 0;
  function normalize(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "attributes" && child && typeof child.src === "string") {
        substitutions += child.src.split(nativeYosysSharePath).length - 1;
        child.src = child.src.replaceAll(nativeYosysSharePath, "/share");
      }
      normalize(child);
    }
  }
  for (const document of [native, wasi]) {
    assertYosysCreator(document.creator);
    normalize(document);
  }
  // Build identity and the mounted share path are not circuit differences.
  wasi.creator = native.creator;
  assert.ok(substitutions > 0, "No native share path was found under attributes.src");
  assert.equal(JSON.stringify(native), JSON.stringify(wasi), "Native/WASI synthesis JSON differs (including key order)");
  return substitutions;
}
