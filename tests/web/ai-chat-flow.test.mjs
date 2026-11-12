import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { AI_CHAT_INITIAL_STATE, AI_CHAT_TRANSITIONS, transitionAiChat } from "../../web/lib/ai-chat-flow.mjs";
const directory = new URL("../../docs/ux/out/", import.meta.url);
test("ai_chat implementation exactly matches every generated state/event/target/guard", () => {
  const [file] = readdirSync(directory).filter((p) => /ai_chat.*xstate.*json$/.test(p));
  const contract = JSON.parse(readFileSync(new URL(file, directory), "utf8"));
  assert.equal(AI_CHAT_INITIAL_STATE, contract.initial);
  assert.deepEqual(AI_CHAT_TRANSITIONS, Object.fromEntries(Object.entries(contract.states).map(([s, v]) => [s, v.on ?? {}])));
  for (const [state, rules] of Object.entries(AI_CHAT_TRANSITIONS)) {
    for (const [event, rule] of Object.entries(rules)) {
      const target = typeof rule === "string" ? rule : rule[0].target;
      assert.equal(transitionAiChat(state, event, { context_valid: true, connected: true, preview_current: true }), target);
      if (Array.isArray(rule)) assert.equal(transitionAiChat(state, event, {}), state);
    }
  }
  assert.equal(transitionAiChat("previewing", "inputs_changed"), "composing");
  assert.equal(transitionAiChat("composing", "send_requested", { connected: true, preview_current: true }), "composing");
  assert.equal(transitionAiChat("previewing", "send_requested", { connected: true, preview_current: false }), "previewing");
});
