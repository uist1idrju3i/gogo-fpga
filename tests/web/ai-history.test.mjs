import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compactUserTurn } from "../../web/lib/ai-history.mjs";
import { createChatPreview } from "../../web/lib/openrouter-chat.mjs";
import { AI_SKILLS, buildSystemPrompt } from "../../web/lib/ai-skills.mjs";

test("every skill explains omitted earlier materials", () => {
  for (const skill of AI_SKILLS) assert.match(buildSystemPrompt(skill.id), /sha256.*推測せず.*再送/s);
});

test("compact materials retain metadata and UTF-8 hashes without modifying the full turn", async () => {
  const value = { request: "相談", skill: "consult", project: { name: "a" }, problems: [{ message: "error" }],
    files: [{ path: "src/a.v", content: "日本語\n" }], logs: [{ tool: "yosys", text: "abc" }] };
  const full = JSON.stringify(value);
  const compact = JSON.parse(await compactUserTurn(full));
  assert.deepEqual(compact, { ...value,
    files: [{ path: "src/a.v", sha256: createHash("sha256").update("日本語\n").digest("hex"), bytes: 10 }],
    logs: [{ tool: "yosys", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3 }] });
  assert.equal(full, JSON.stringify(value));
});

test("empty materials and invalid JSON", async () => {
  assert.deepEqual(JSON.parse(await compactUserTurn('{"files":[],"logs":[]}')), { files: [], logs: [] });
  await assert.rejects(compactUserTurn("{"), SyntaxError);
});

test("preview defaults to compact earlier users, with full resend opt-in and unchanged current turn", async () => {
  const base = { model: "x", prompt: "相談", origin: "https://example.test", files: [["src/a.v", "current"]] };
  const full = createChatPreview(base).user;
  const compact = await compactUserTurn(full);
  const history = [{ role: "user", content: full, compact }, { role: "assistant", content: "answer" }];
  for (const resendHistory of [false, true]) {
    const preview = createChatPreview({ ...base, history, resendHistory });
    const messages = JSON.parse(preview.body).messages;
    assert.equal(messages[1].content, resendHistory ? full : compact);
    assert.deepEqual(messages[2], history[1]);
    assert.equal(JSON.parse(messages[3].content).files[0].content, "current");
  }
});
