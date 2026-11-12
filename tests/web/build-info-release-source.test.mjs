import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "toolchain-release-source-"));
  const artifacts = join(root, "build/jspi-pthread");
  const buildScript = "#!/bin/sh\nprintf 'release-source fixture\\n'\n";
  const submoduleShas = Object.fromEntries(
    submodules.map((path, index) => [path, String(index + 1).repeat(40)]),
  );
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(root, "scripts/build-wasm.sh"), buildScript);
  writeFileSync(join(artifacts, "openFPGALoader.mjs"), "export default 1;\n");
  writeFileSync(join(artifacts, "openFPGALoader.wasm"), "fake wasm bytes\n");

  const sdkRoot = join(root, "build/emsdk-6.0.13");
  const sdkBin = join(sdkRoot, "bin");
  mkdirSync(sdkBin, { recursive: true });
  writeFileSync(
    join(sdkRoot, "emsdk_env.sh"),
    `export PATH="${sdkBin}:$PATH"\n`,
  );
  const emcc = join(sdkBin, "emcc");
  writeFileSync(emcc, "#!/bin/sh\nprintf 'emcc release-source test\\n'\n");
  chmodSync(emcc, 0o755);

  const releaseSource = {
    version: "v0.1.0",
    commit: "a".repeat(40),
    submodule_shas: submoduleShas,
    emsdk_version: "6.0.13",
    source_date_epoch: 1,
  };
  const manifestPath = join(root, "RELEASE-SOURCE.json");
  writeFileSync(manifestPath, `${JSON.stringify(releaseSource, null, 2)}\n`);
  const infoPath = join(artifacts, "build-info.json");
  return { root, artifacts, buildScript, infoPath, manifestPath, releaseSource };
}

function runBuildInfo(fixture, action, extraArgs = []) {
  return spawnSync(
    "python3",
    [
      buildInfoScript,
      action,
      "--root",
      fixture.root,
      "--artifacts",
      fixture.artifacts,
      ...extraArgs,
    ],
    { encoding: "utf8" },
  );
}

function writeBuildInfo(fixture) {
  return runBuildInfo(fixture, "write", [
    "--variant",
    "C",
    "--async-mode",
    "jspi",
  ]);
}

test("release-source metadata supports write, check, and artifact checks without git", () => {
  const fixture = createFixture();
  try {
    const write = writeBuildInfo(fixture);
    assert.equal(write.status, 0, `${write.stdout}${write.stderr}`);
    assert.match(write.stdout, /Release-source mode is on/);

    const info = JSON.parse(readFileSync(fixture.infoPath, "utf8"));
    assert.deepEqual(info.submodule_shas, fixture.releaseSource.submodule_shas);
    assert.equal(info.emcc_version, "emcc release-source test");
    assert.equal(
      info.zstd_version,
      execFileSync("zstd", ["--version"], { encoding: "utf8" }).match(
        /\bv(\d+\.\d+\.\d+)\b/,
      )?.[1],
    );

    for (const action of ["check", "check-artifacts"]) {
      const result = runBuildInfo(fixture, action);
      assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
      assert.match(result.stdout, /Release-source mode is on/);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("release-source mode rejects missing manifest keys", () => {
  const fixture = createFixture();
  try {
    delete fixture.releaseSource.emsdk_version;
    writeFileSync(
      fixture.manifestPath,
      `${JSON.stringify(fixture.releaseSource, null, 2)}\n`,
    );
    const result = runBuildInfo(fixture, "check-artifacts");
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(
      output,
      /Release-source metadata is missing required keys: emsdk_version/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("release-source artifact checks reject manifest gitlink mismatches", () => {
  const fixture = createFixture();
  try {
    const write = writeBuildInfo(fixture);
    assert.equal(write.status, 0, `${write.stdout}${write.stderr}`);
    const info = JSON.parse(readFileSync(fixture.infoPath, "utf8"));
    info.submodule_shas["vendor/emsdk"] = "0".repeat(40);
    writeFileSync(fixture.infoPath, `${JSON.stringify(info, null, 2)}\n`);

    const result = runBuildInfo(fixture, "check-artifacts");
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0, output);
    assert.match(
      output,
      /Build metadata submodule_shas does not match superproject gitlinks/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("release-source mode is ignored when the root has a git repository", () => {
  const fixture = createFixture();
  try {
    const write = writeBuildInfo(fixture);
    assert.equal(write.status, 0, `${write.stdout}${write.stderr}`);
    git(fixture.root, "init", "-q");
    git(fixture.root, "config", "user.name", "Release source test");
    git(fixture.root, "config", "user.email", "release-source@example.invalid");
    git(fixture.root, "add", "scripts/build-wasm.sh");
    for (const [path, sha] of Object.entries(fixture.releaseSource.submodule_shas)) {
      git(fixture.root, "update-index", "--add", "--cacheinfo", `160000,${sha},${path}`);
    }
    git(fixture.root, "commit", "-qm", "fixture");
    writeFileSync(fixture.manifestPath, "{}\n");

    const result = runBuildInfo(fixture, "check-artifacts");
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /Release-source mode is on/);
    assert.match(result.stdout, /Verified artifact metadata/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
