import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMPLETION_LIMITS, completionContext, sanitizeCompletion, availabilityMessage, createLocalCompleter } from "../../web/lib/local-completion.mjs";

test("completion context is current-file text bounded on UTF-8 boundaries", () => {
  const text = "あ".repeat(3000) + "xyz" + "い".repeat(3000);
  const value = completionContext({ text, cursor: 3003, path: "src/top.v", language: "verilog" });
  assert.equal(value.path, "src/top.v"); assert.equal(value.language, "verilog");
  assert.ok(new TextEncoder().encode(value.prefix).length <= COMPLETION_LIMITS.prefixBytes);
  assert.ok(new TextEncoder().encode(value.suffix).length <= COMPLETION_LIMITS.suffixBytes);
  assert.ok(value.prefix.endsWith("xyz")); assert.ok(value.suffix.startsWith("い"));
  assert.ok(!JSON.stringify(value).includes("\ufffd"));
  assert.deepEqual(completionContext({ text: "", cursor: 0, path: "x", language: "plain" }), { path: "x", language: "plain", prefix: "", suffix: "" });
});

test("completion sanitizes controls, limits lines and characters and drops repeated suffix", () => {
  assert.equal(sanitizeCompletion("\x00a\t\n\x1bb\x7f\x85"), "a\t\nb");
  assert.equal(sanitizeCompletion("x".repeat(1000)).length, COMPLETION_LIMITS.characters);
  assert.equal(sanitizeCompletion("line\n".repeat(30)).split("\n").length, COMPLETION_LIMITS.lines);
  assert.equal(sanitizeCompletion("endmodule", "\nendmodule\n"), "");
  assert.equal(sanitizeCompletion(" \n\t"), "");
  assert.equal(sanitizeCompletion("<img src=x>"), "<img src=x>");
});

function fakeModel({ availability = "available", failure = false, delayed = false } = {}) {
  const record = { creates: 0, prompts: [], signals: [], destroyed: 0 };
  const model = {
    async availability() { return availability; },
    async create(options) {
      record.creates++; options.monitor({ addEventListener(name, callback) { assert.equal(name, "downloadprogress"); callback({ loaded: 0.5 }); } });
      if (failure) throw new Error("not ready");
      return {
        contextUsage: 0, inputQuota: 10000,
        destroy() { record.destroyed++; },
        async clone() {
          return {
            destroy() { record.destroyed++; },
            promptStreaming(prompt, { signal }) {
              record.prompts.push(prompt); record.signals.push(signal);
              return new ReadableStream({ start(controller) {
                if (delayed) signal.addEventListener("abort", () => controller.error(new DOMException("abort", "AbortError")), { once: true });
                else { controller.enqueue("wire "); controller.enqueue("ready;\n"); controller.close(); }
              } });
            },
          };
        },
      };
    },
  };
  return { model, record };
}

test("availability states are fail-closed, Japanese, and probe never creates a session", async () => {
  for (const availability of ["unavailable", "downloadable", "downloading", "available", "unknown"]) {
    const { model, record } = fakeModel({ availability });
    const client = createLocalCompleter({ model });
    assert.equal(await client.probe(), availability === "unknown" ? "unavailable" : availability);
    assert.match(availabilityMessage(availability), /[ぁ-んァ-ヶ一-龠]/);
    assert.equal(record.creates, 0); assert.equal(client.state.enabled, false);
  }
  const client = createLocalCompleter({ model: null });
  assert.equal(await client.probe(), "unavailable"); assert.equal(await client.enable(), false);
});

test("explicit enable reports download progress and each completion uses an isolated session", async () => {
  const { model, record } = fakeModel({ availability: "downloadable" }), statuses = [];
  const client = createLocalCompleter({ model, onStatus: state => statuses.push(state) });
  await client.probe(); assert.equal(await client.complete({}), "");
  assert.equal(await client.enable(), true);
  assert.ok(statuses.some(state => state.availability === "downloading" && state.progress === 50));
  assert.equal(client.state.availability, "available");
  const context = { path: "src/top.v", language: "verilog", prefix: "module top;", suffix: "endmodule" };
  assert.equal(await client.complete(context), "wire ready;\n");
  assert.ok(record.prompts[0].endsWith(JSON.stringify(context)));
  assert.equal(record.destroyed, 1);
  client.disable(); assert.equal(client.state.enabled, false); assert.equal(record.destroyed, 2);
});

test("edit cancellation aborts the in-flight model request and ignores its result", async () => {
  const { model, record } = fakeModel({ delayed: true });
  const client = createLocalCompleter({ model }); await client.probe(); await client.enable();
  const pending = client.complete({ prefix: "", suffix: "" });
  await Promise.resolve(); client.cancel();
  assert.equal(record.signals[0].aborted, true); assert.equal(await pending, "");
  client.disable();
});

test("model creation and availability failures stay disabled without exposing errors", async () => {
  const { model } = fakeModel({ failure: true }); const client = createLocalCompleter({ model });
  await client.probe(); assert.equal(await client.enable(), false); assert.equal(client.state.enabled, false);
  assert.match(client.state.note, /準備できませんでした/);
  assert.equal(await createLocalCompleter({ model: { availability() { throw new Error("private"); } } }).probe(), "unavailable");
});

test("completion implementation has no transport API or cloud fallback", async () => {
  for (const file of ["../../web/lib/local-completion.mjs", "../../web/editor/editor.mjs"]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /fetch|XMLHttpRequest|WebSocket|openrouter/i);
  }
});
