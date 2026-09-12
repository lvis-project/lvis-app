import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  getLlmVendorSettings,
} from "../../../../shared/llm-vendor-defaults.js";
import { collectRoundStream } from "../../../turn/stream-collector.js";
import { VercelUnifiedProvider } from "../adapter.js";

function responseBody(vendor: "openai-compatible" | "claude"): string {
  const events = vendor === "claude" ? [
    { type: "message_start", message: { id: "response", model: "fixture", role: "assistant", usage: { input_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ] : [
    { id: "response", model: "fixture", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
    { id: "response", model: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

async function collectRequest(
  vendor: "openai-compatible" | "claude",
  model: string,
  overrides: { outputTokenLimit?: number; thinkingBudgetTokens?: number; enableThinking?: boolean } = {},
) {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response(responseBody(vendor), {
    headers: { "content-type": "text/event-stream" },
  }));
  const provider = new VercelUnifiedProvider(vendor, "fixture-key", "https://provider.invalid/v1", fetchResponse);
  const block = getLlmVendorSettings({ [vendor]: { model, enableThinking: true, thinkingBudgetTokens: 10_000, ...overrides } }, vendor);
  const result = await collectRoundStream({
    provider, model, systemPrompt: "Return the result.",
    messages: [{ role: "user", content: "Report the value." }], toolSchemas: [],
    llmSettings: { ...block, streamSmoothing: "none" },
  });
  expect(fetchResponse).toHaveBeenCalledTimes(1);
  return { result, body: JSON.parse(String(fetchResponse.mock.calls[0]![1]!.body)) as Record<string, unknown> };
}

describe("resolved output ceiling on the native wire", () => {
  it("sends the default from existing settings and preserves a completed response", async () => {
    const { body, result } = await collectRequest("openai-compatible", "fixture-model");
    expect(body.max_tokens).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
    expect(body.thinking_budget_tokens).toBe(10_000);
    expect(result).toMatchObject({ kind: "ok", text: "ok", stopReason: "end_turn" });
  });

  it.each([2_048, 64_000])("preserves explicit ceiling %i without applying a background bound", async (outputTokenLimit) => {
    const { body } = await collectRequest("openai-compatible", "fixture-model", { outputTokenLimit });
    expect(body.max_tokens).toBe(outputTokenLimit);
  });

  it("keeps numeric thinking inside the total ceiling after SDK projection", async () => {
    const { body, result } = await collectRequest("claude", "claude-3-7-sonnet-latest");
    expect(body.max_tokens).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
    expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 10_000 });
    expect(result).toMatchObject({ kind: "ok", text: "ok" });
  });

  it("leaves response capacity when the requested thinking equals the output ceiling", async () => {
    const { body } = await collectRequest("claude", "claude-3-7-sonnet-latest", { thinkingBudgetTokens: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT });
    expect(body.max_tokens).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
    expect(body.thinking).toMatchObject({ budget_tokens: DEFAULT_LLM_OUTPUT_TOKEN_LIMIT - 1 });
  });

  it("transmits adaptive effort in the provider's output configuration", async () => {
    const { body } = await collectRequest("claude", "claude-sonnet-4-6", { thinkingBudgetTokens: 16_000 });
    expect(body.max_tokens).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.output_config).toMatchObject({ effort: "high" });
  });

  it("uses numeric thinking for model generations without adaptive mode", async () => {
    const { body } = await collectRequest("claude", "claude-sonnet-4-5", { thinkingBudgetTokens: 16_000 });
    expect(body.max_tokens).toBe(DEFAULT_LLM_OUTPUT_TOKEN_LIMIT);
    expect(body.thinking).toMatchObject({ type: "enabled", budget_tokens: 16_000 });
  });

  it("reports a ceiling too small for enabled numeric thinking before dispatch", async () => {
    const fetchResponse = vi.fn<typeof fetch>();
    const provider = new VercelUnifiedProvider("claude", "fixture-key", "https://provider.invalid/v1", fetchResponse);
    const result = await collectRoundStream({
      provider, model: "claude-3-7-sonnet-latest", systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas: [],
      llmSettings: { streamSmoothing: "none", enableThinking: true, thinkingBudgetTokens: 1_024, outputTokenLimit: 1_024 },
    });
    expect(fetchResponse).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "stream_error", userMessage: expect.stringContaining("Output token limit") });
  });
});
