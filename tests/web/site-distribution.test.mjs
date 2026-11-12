import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("the assembled app preserves the product identity and discovery metadata", () => {
  const html = read("public_html/index.html");
  assert.equal(html, read("web/index.html"));
  assert.match(html, /<title>午後のFPGA<\/title>/);
  assert.match(html, /<h1>午後のFPGA<\/h1>/);
  assert.match(html, /name="description" content="午後のFPGA"/);
  assert.match(html, /name="keywords" content="FPGA,TangNano1K,TangNano4K,TangNano9K,TangNano20K"/);
  assert.match(html, /name="robots" content="index,follow"/);
  assert.doesNotMatch(html, /Web Toolchain|Web Flasher|GOWIN FPGA/i);
});

test("public_html is generated output with the same isolation policy as the source", () => {
  assert.equal(execFileSync("git", ["check-ignore", "public_html/index.html"], {
    cwd: root, encoding: "utf8",
  }).trim(), "public_html/index.html");
  assert.equal(execFileSync("git", ["ls-files", "public_html"], {
    cwd: root, encoding: "utf8",
  }), "");
  const headers = read("public_html/_headers");
  assert.equal(headers, read("web/_headers"));
  assert.match(headers, /^\/\*\n/m);
  assert.match(headers, /Cross-Origin-Opener-Policy: same-origin/);
  assert.match(headers, /Cross-Origin-Embedder-Policy: require-corp/);
});

test("package metadata identifies the unified product", () => {
  const metadata = JSON.parse(read("package.json"));
  assert.equal(metadata.name, "gogo-fpga");
  assert.equal(metadata.description, "午後のFPGA");
  assert.equal(metadata.license, "BSD-3-Clause");
});
