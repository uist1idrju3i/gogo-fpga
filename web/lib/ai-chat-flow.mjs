export const AI_CHAT_INITIAL_STATE = "composing";
export const AI_CHAT_TRANSITIONS = Object.freeze(Object.fromEntries(Object.entries({
  composing: { preview_requested: [{ target: "previewing", guard: "context_valid" }] },
  previewing: { send_requested: [{ target: "sending", guard: "connected && preview_current" }], inputs_changed: "composing" },
  sending: { chunk_received: "streaming", response_completed: "proposal_review", send_failed: "failed", stop_requested: "composing" },
  streaming: { chunk_received: "streaming", response_completed: "proposal_review", send_failed: "failed", stop_requested: "composing" },
  proposal_review: { preview_requested: [{ target: "previewing", guard: "context_valid" }], inputs_changed: "composing" },
  failed: { preview_requested: [{ target: "previewing", guard: "context_valid" }], inputs_changed: "composing" },
}).map(([state, rules]) => [state, Object.freeze({ ...rules, clear_requested: "composing", disconnected: "composing" })])));

export function transitionAiChat(state, event, context = {}) {
  if (!Object.hasOwn(AI_CHAT_TRANSITIONS, state)) throw new TypeError("Unknown AI chat state");
  const rules = AI_CHAT_TRANSITIONS[state];
  if (!Object.hasOwn(rules, event)) return state;
  const rule = rules[event];
  if (typeof rule === "string") return rule;
  return rule.find(({ guard }) => guard.split(" && ").every((name) => context && Object.hasOwn(context, name) && context[name] === true))?.target ?? state;
}
