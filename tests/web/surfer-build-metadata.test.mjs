import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const helper = join(root, "scripts/surfer-build-metadata.py");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "surfer-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(directory, ...args) {
  const date = args.find((argument) => argument.startsWith("--date="))?.slice(7)
    ?? "2020-01-02T00:00:00Z";
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
      GIT_AUTHOR_DATE: "2020-01-02T00:00:00Z",
      GIT_COMMITTER_DATE: date,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function metadata(source, commit) {
  return spawnSync("python3", [helper, "--source", source, "--commit", commit], {
    encoding: "utf8",
  });
}

test("Surfer metadata follows its own commit, not changing parent commits", (t) => {
  const parent = fixture(t);
  git(parent, "init", "--quiet");
  git(parent, "commit", "--allow-empty", "-m", "parent-a");
  const source = join(parent, "vendor/surfer");
  mkdirSync(source, { recursive: true });
  git(source, "init", "--quiet");
  git(source, "commit", "--allow-empty", "-m", "surfer");
  const commit = git(source, "rev-parse", "HEAD");
  const first = metadata(source, commit);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "1577923200\t2020-01-02\n");
  const before = git(parent, "rev-parse", "HEAD");
  git(parent, "commit", "--allow-empty", "--date=2030-02-03T00:00:00Z", "-m", "parent-b");
  assert.notEqual(git(parent, "rev-parse", "HEAD"), before);
  assert.notEqual(git(parent, "show", "-s", "--format=%ct", "HEAD"), "1577923200");
  assert.equal(metadata(source, commit).stdout, first.stdout);
  assert.equal(metadata(source, "0".repeat(40)).status, 1);
});

test("source archive metadata matches Git and never falls back to the parent", (t) => {
  const parent = fixture(t);
  git(parent, "init", "--quiet");
  git(parent, "commit", "--allow-empty", "-m", "unrelated parent");
  const source = join(parent, "archive/vendor/surfer");
  mkdirSync(source, { recursive: true });
  const commit = git(parent, "rev-parse", "HEAD");
  assert.equal(metadata(source, commit).status, 1);
  writeFileSync(join(source, ".gitcommit"), `${commit}\n`);
  assert.equal(metadata(source, commit).status, 1);
  writeFileSync(join(source, ".gitcommit-timestamp"), "1577923200\n");
  const result = metadata(source, commit);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "1577923200\t2020-01-02\n");
  assert.equal(metadata(source, "f".repeat(40)).status, 1);
  for (const timestamp of ["", "-1", "1.5", "invalid", "9".repeat(30)]) {
    writeFileSync(join(source, ".gitcommit-timestamp"), timestamp);
    const invalid = metadata(source, commit);
    assert.equal(invalid.status, 1, timestamp);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Surfer source metadata:/);
  }
});

test("release source archives include the Surfer metadata helper and timestamp", () => {
  const script = readFileSync(join(root, "scripts/package-release.sh"), "utf8");
  assert.ok(script.includes('"$source_root/scripts/surfer-build-metadata.py"'));
  assert.match(script, /git -C "\$root\/vendor\/surfer" show -s --format=%ct "\$surfer_pin" \\\n\s+> "\$source_root\/vendor\/surfer\/\.gitcommit-timestamp"/);
});
