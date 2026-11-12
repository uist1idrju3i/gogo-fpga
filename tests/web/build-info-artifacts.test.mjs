import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "../..");
const buildInfoScript = resolve(repoRoot, "scripts/build-info.py");
const buildWebScript = resolve(repoRoot, "scripts/build-web.sh");
const zstdVersion = execFileSync("zstd", ["--version"], { encoding: "utf8" })
  .match(/\bv(\d+\.\d+\.\d+)\b/)?.[1];
const submodules = [
  "vendor/emsdk",
  "vendor/iverilog",
  "vendor/surfer",
  "vendor/libftdi",
  "vendor/libusb",
  "vendor/openFPGALoader",
  "vendor/yomiyasu",
  "vendor/zlib",
  "vendor/yosys",
];

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "toolchain-build-info-artifacts-"));
  const artifacts = join(root, "build/jspi-pthread");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  const buildScript = "#!/bin/sh\nprintf fixture\\n";
  writeFileSync(join(root, "scripts/build-wasm.sh"), buildScript);
  writeFileSync(join(artifacts, "openFPGALoader.mjs"), "export default 1;\n");
  writeFileSync(join(artifacts, "openFPGALoader.wasm"), "fake wasm bytes\n");

  git(root, "init", "-q");
  git(root, "config", "user.name", "Build info test");
  git(root, "config", "user.email", "build-info@example.invalid");
  git(root, "add", "scripts/build-wasm.sh");
  const submoduleShas = Object.fromEntries(
    submodules.map((path, index) => [path, String(index + 1).repeat(40)]),
  );
  for (const [path, sha] of Object.entries(submoduleShas)) {
    git(root, "update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
  }
  git(root, "commit", "-qm", "fixture");

  const metadata = {
    variant: "C",
    async_mode: "jspi",
    build_script_sha256: sha256(buildScript),
    submodule_shas: submoduleShas,
    emcc_version: "emcc test version",
    zstd_version: zstdVersion,
    artifacts: {
      "openFPGALoader.mjs": sha256(readFileSync(join(artifacts, "openFPGALoader.mjs"))),
      "openFPGALoader.wasm": sha256(readFileSync(join(artifacts, "openFPGALoader.wasm"))),
    },
  };
  const infoPath = join(artifacts, "build-info.json");
  writeFileSync(infoPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { root, artifacts, infoPath, metadata };
}

function runCheck(fixture) {
  return spawnSync(
    "python3",
    [
      buildInfoScript,
      "check-artifacts",
      "--root",
      fixture.root,
      "--artifacts",
      fixture.artifacts,
    ],
    { encoding: "utf8" },
  );
}

function assertFailure(fixture, expected) {
  const result = runCheck(fixture);
  const output = `${result.stdout}${result.stderr}`;
  assert.notEqual(result.status, 0, output);
  assert.match(output, expected);
}

function testFailure(name, expected, mutate) {
  test(name, () => {
    const fixture = createFixture();
    try {
      mutate(fixture);
      assertFailure(fixture, expected);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
}

test("check-artifacts accepts a clean build artifact with uninitialized gitlinks", () => {
  const fixture = createFixture();
  try {
    const result = runCheck(fixture);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /Verified artifact metadata/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

testFailure(
  "check-artifacts rejects a tampered wasm",
  /Build metadata artifacts do not match downloaded files/,
  ({ artifacts }) => writeFileSync(join(artifacts, "openFPGALoader.wasm"), "tampered\n"),
);
testFailure(
  "check-artifacts rejects a tampered mjs",
  /Build metadata artifacts do not match downloaded files/,
  ({ artifacts }) => writeFileSync(join(artifacts, "openFPGALoader.mjs"), "tampered\n"),
);
testFailure(
  "check-artifacts rejects a gitlink mismatch",
  /submodule_shas does not match superproject gitlinks/,
  ({ infoPath, metadata }) => {
    metadata.submodule_shas["vendor/emsdk"] = "0".repeat(40);
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects a missing submodule key",
  /submodule_shas does not match superproject gitlinks/,
  ({ infoPath, metadata }) => {
    delete metadata.submodule_shas["vendor/emsdk"];
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects an extra submodule path",
  /submodule_shas does not match superproject gitlinks/,
  ({ infoPath, metadata }) => {
    metadata.submodule_shas["vendor/extra"] = "0".repeat(40);
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects an extra metadata key",
  /Build metadata keys do not match/,
  ({ infoPath, metadata }) => {
    metadata.extra = true;
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects a missing metadata key",
  /Build metadata keys do not match/,
  ({ infoPath, metadata }) => {
    delete metadata.async_mode;
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects a changed build-wasm.sh",
  /build_script_sha256 does not match current build script/,
  ({ root }) => writeFileSync(join(root, "scripts/build-wasm.sh"), "# changed\n"),
);
testFailure(
  "check-artifacts rejects a wrong variant",
  /Build metadata variant must be C/,
  ({ infoPath, metadata }) => {
    metadata.variant = "B";
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects an empty emcc_version",
  /emcc_version must be a non-empty string/,
  ({ infoPath, metadata }) => {
    metadata.emcc_version = "";
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);
testFailure(
  "check-artifacts rejects a mismatched zstd_version",
  /zstd_version does not match the current CLI/,
  ({ infoPath, metadata }) => {
    metadata.zstd_version = "0.0.0";
    writeFileSync(infoPath, `${JSON.stringify(metadata)}\n`);
  },
);

test("build-web rejects an unknown BUILD_INFO_CHECK value", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "toolchain-build-web-mode-"));
  try {
    const result = spawnSync("bash", [buildWebScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        BUILD_INFO_CHECK: "unknown",
        BUILD_ROOT: temporaryRoot,
      },
    });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(output, /Unsupported BUILD_INFO_CHECK value: unknown/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
