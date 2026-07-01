// Locks the cache-token reporting fix: Anthropic sends cache_read_input_tokens in the
// message_start event (NOT message_delta). The translator must carry it through so the
// final OpenAI usage exposes prompt_tokens_details.cached_tokens.
import { describe, it, expect } from "vitest";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

function runStream(events) {
  const state = { toolCalls: new Map() };
  let last = null;
  for (const ev of events) {
    const out = claudeToOpenAIResponse(ev, state);
    if (out) for (const c of out) if (c.usage) last = c.usage;
  }
  return { state, usage: last };
}

describe("claude->openai response usage carries cache tokens", () => {
  const stream = [
    { type: "message_start", message: { id: "msg_1", model: "claude-opus-4", usage: { input_tokens: 12, cache_read_input_tokens: 145817, cache_creation_input_tokens: 1698 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ];

  it("exposes cached_tokens from message_start in the final usage", () => {
    const { usage } = runStream(stream);
    expect(usage).toBeTruthy();
    expect(usage.prompt_tokens_details?.cached_tokens).toBe(145817);
    expect(usage.prompt_tokens_details?.cache_creation_tokens).toBe(1698);
  });

  it("prompt_tokens folds input + cache_read + cache_creation", () => {
    const { usage } = runStream(stream);
    expect(usage.prompt_tokens).toBe(12 + 145817 + 1698);
    expect(usage.completion_tokens).toBe(40);
  });

  it("no cache fields -> no prompt_tokens_details (clean usage)", () => {
    const { usage } = runStream([
      { type: "message_start", message: { id: "m", model: "claude-opus-4", usage: { input_tokens: 5 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ]);
    expect(usage.prompt_tokens).toBe(5);
    expect(usage.prompt_tokens_details).toBeUndefined();
  });
});
