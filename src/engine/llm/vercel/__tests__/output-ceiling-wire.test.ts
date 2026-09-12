import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LLM_OUTPUT_TOKEN_LIMIT,
  getLlmVendorSettings,
} from "../../../../shared/llm-vendor-defaults.js";
import { collectRoundStream } from "../../../turn/stream-collector.js";
import { forbidAmbientFetch } from "../../../../__tests__/support/network-fetch-stubs.js";
import type { ToolSchema } from "../../types.js";
import { createGuardedModelProviderFetch } from "../../marketplace-provider-fetch.js";
import { VercelUnifiedProvider } from "../adapter.js";
import { collectStreamEvents } from "./test-helpers.js";

const TOOL_SCHEMAS: ToolSchema[] = [{
  name: "read_value",
  description: "Read the current value.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
}];

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
  toolSchemas: ToolSchema[] = [],
) {
  const fetchResponse = vi.fn<typeof fetch>(async () => new Response(responseBody(vendor), {
    headers: { "content-type": "text/event-stream" },
  }));
  const provider = new VercelUnifiedProvider(vendor, "fixture-key", "https://provider.invalid/v1", fetchResponse);
  const block = getLlmVendorSettings({ [vendor]: { model, enableThinking: true, thinkingBudgetTokens: 10_000, ...overrides } }, vendor);
  const result = await collectRoundStream({
    provider, model, systemPrompt: "Return the result.",
    messages: [{ role: "user", content: "Report the value." }], toolSchemas,
    llmSettings: { ...block, streamSmoothing: "none" },
  });
  expect(fetchResponse).toHaveBeenCalledTimes(1);
  const request = fetchResponse.mock.calls[0]![1]!;
  return {
    result,
    body: JSON.parse(String(request.body)) as Record<string, unknown>,
    headers: new Headers(request.headers),
  };
}

describe("resolved output ceiling on the native wire", () => {
  beforeEach(forbidAmbientFetch);
  afterEach(() => vi.unstubAllGlobals());

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

  it.each([
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-opus-4-20250514",
    "claude-opus-4-1-20250805",
    "claude-opus-4-5-20251101",
  ])("keeps an interleaved budget above a small total for %s", async (model) => {
    const { body, headers, result } = await collectRequest(
      "claude", model, { outputTokenLimit: 1_024, thinkingBudgetTokens: 2_048 }, TOOL_SCHEMAS,
    );
    expect(body.max_tokens).toBe(1_024);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2_048 });
    expect(headers.get("anthropic-beta")).toContain("interleaved-thinking-2025-05-14");
    expect(result).toMatchObject({ kind: "ok", text: "ok", stopReason: "end_turn" });
  });

  it.each([1, 1_024, 32_000])("preserves the interleaved budget with total %i", async (outputTokenLimit) => {
    const { body } = await collectRequest(
      "claude", "claude-sonnet-4-5", { outputTokenLimit, thinkingBudgetTokens: 32_000 }, TOOL_SCHEMAS,
    );
    expect(body.max_tokens).toBe(outputTokenLimit);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32_000 });
  });

  it("preserves the SDK's lower model limit before projecting an interleaved total", async () => {
    const { body } = await collectRequest(
      "claude", "claude-opus-4-1", { outputTokenLimit: 64_000, thinkingBudgetTokens: 48_000 }, TOOL_SCHEMAS,
    );
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 48_000 });
  });

  it("fits an ordinary thinking budget inside the SDK's lower model limit", async () => {
    const { body } = await collectRequest(
      "claude", "claude-opus-4-1", { outputTokenLimit: 64_000, thinkingBudgetTokens: 48_000 },
    );
    expect(body.max_tokens).toBe(32_000);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 31_999 });
  });

  it.each(["claude-haiku-4-5", "claude-3-7-sonnet-latest"])(
    "keeps ordinary numeric constraints with tools on %s", async (model) => {
      const { body, headers } = await collectRequest(
        "claude", model, { outputTokenLimit: 1_025, thinkingBudgetTokens: 2_048 }, TOOL_SCHEMAS,
      );
      expect(body.max_tokens).toBe(1_025);
      expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1_024 });
      expect(headers.get("anthropic-beta") ?? "").not.toContain("interleaved-thinking");
    },
  );

  it("leaves a smaller purpose limit intact when thinking is disabled", async () => {
    const { body } = await collectRequest("claude", "claude-sonnet-4-5", { outputTokenLimit: 12, enableThinking: false });
    expect(body.max_tokens).toBe(12);
    expect(body.thinking).toBeUndefined();
  });

  it.each([
    { model: "claude-sonnet-4-5", toolSchemas: [] },
    { model: "claude-3-7-sonnet-latest", toolSchemas: TOOL_SCHEMAS },
    { model: "claude-haiku-4-5", toolSchemas: TOOL_SCHEMAS },
    { model: "unknown-numeric-model", toolSchemas: TOOL_SCHEMAS },
  ])("rejects an impossible ordinary total before transport for $model", async ({ model, toolSchemas }) => {
    const fetchResponse = vi.fn<typeof fetch>();
    const provider = new VercelUnifiedProvider("claude", "fixture-key", "https://provider.invalid/v1", fetchResponse);
    const result = await collectRoundStream({
      provider, model, systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas,
      llmSettings: { streamSmoothing: "none", enableThinking: true, thinkingBudgetTokens: 1_024, outputTokenLimit: 1_024 },
    });
    expect(fetchResponse).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "stream_error", userMessage: expect.stringContaining("Output token limit") });
  });

  it("projects the body through the configured guarded transport", async () => {
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response(responseBody("claude"), {
      headers: { "content-type": "text/event-stream" },
    }));
    const baseUrl = "http://127.0.0.1:30000/v1";
    const provider = new VercelUnifiedProvider(
      "claude", "fixture-key", baseUrl, createGuardedModelProviderFetch(baseUrl, fetchResponse),
    );
    const result = await collectRoundStream({
      provider, model: "claude-sonnet-4-5", systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas: TOOL_SCHEMAS,
      llmSettings: { streamSmoothing: "none", enableThinking: true, thinkingBudgetTokens: 2_048, outputTokenLimit: 1_024 },
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    const [url, init] = fetchResponse.mock.calls[0]!;
    expect(String(url)).toBe(`${baseUrl}/messages`);
    expect(JSON.parse(String(init?.body))).toMatchObject({ max_tokens: 1_024, thinking: { budget_tokens: 2_048 } });
    expect(new Headers(init?.headers).get("x-api-key")).toBe("fixture-key");
    expect(init?.redirect).toBe("manual");
    expect(result).toMatchObject({ kind: "ok", text: "ok" });
  });

  it("propagates caller cancellation through the projected request", async () => {
    const controller = new AbortController();
    const fetchResponse = vi.fn<typeof fetch>(async (_url, init) => {
      controller.abort(new DOMException("Request cancelled", "AbortError"));
      init?.signal?.throwIfAborted();
      throw new Error("Caller cancellation did not reach the provider transport");
    });
    const provider = new VercelUnifiedProvider("claude", "fixture-key", "https://provider.invalid/v1", fetchResponse);
    const result = await collectRoundStream({
      provider, model: "claude-sonnet-4-5", systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas: TOOL_SCHEMAS,
      abortSignal: controller.signal,
      llmSettings: { streamSmoothing: "none", enableThinking: true, thinkingBudgetTokens: 2_048, outputTokenLimit: 1_024 },
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    expect(fetchResponse.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(result).toMatchObject({ kind: "interrupted" });
  });

  it("preserves provider rejection identity after projecting the body", async () => {
    const fetchResponse = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      type: "error", error: { type: "invalid_request_error", message: "The requested output is unavailable" },
    }), { status: 400, headers: { "content-type": "application/json" } }));
    const provider = new VercelUnifiedProvider("claude", "fixture-key", "https://provider.invalid/v1", fetchResponse);
    const result = await collectRoundStream({
      provider, model: "claude-sonnet-4-5", systemPrompt: "Return the result.",
      messages: [{ role: "user", content: "Report the value." }], toolSchemas: TOOL_SCHEMAS,
      llmSettings: { streamSmoothing: "none", enableThinking: true, thinkingBudgetTokens: 2_048, outputTokenLimit: 1_024 },
    });
    expect(fetchResponse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      kind: "stream_error",
      providerError: { origin: "provider", providerType: "invalid_request_error", statusCode: 400, isRetryable: false },
    });
  });

  it("rejects an unexpected SDK serialization without dispatching it", async () => {
    vi.resetModules();
    let projectedFetch: typeof fetch | undefined;
    vi.doMock("@ai-sdk/anthropic", async () => {
      const actual = await vi.importActual<typeof import("@ai-sdk/anthropic")>("@ai-sdk/anthropic");
      return {
        ...actual,
        createAnthropic: (options: Parameters<typeof actual.createAnthropic>[0]) => {
          projectedFetch = options?.fetch as typeof fetch | undefined;
          return actual.createAnthropic(options);
        },
      };
    });
    try {
      const { VercelUnifiedProvider: IsolatedProvider } = await import("../adapter.js");
      const fetchResponse = vi.fn<typeof fetch>(async () => new Response(responseBody("claude"), {
        headers: { "content-type": "text/event-stream" },
      }));
      const provider = new IsolatedProvider("claude", "fixture-key", "https://provider.invalid/v1", fetchResponse);
      await collectStreamEvents(provider.streamTurn({
        model: "claude-sonnet-4-5", systemPrompt: "Return the result.",
        messages: [{ role: "user", content: "Report the value." }],
        enableThinking: true, thinkingBudgetTokens: 2_048, outputTokenLimit: 4_096,
      }));
      expect(fetchResponse).toHaveBeenCalledOnce();
      expect(projectedFetch).toBeTypeOf("function");
      for (const body of [
        undefined,
        "not-json",
        "null",
        "[]",
        '{"max_tokens":4096,"thinking":{"type":"adaptive"}}',
        '{"max_tokens":"4096","thinking":{"type":"enabled","budget_tokens":2048}}',
        '{"max_tokens":4096,"thinking":{"type":"enabled","budget_tokens":null}}',
      ]) {
        await expect(projectedFetch!("https://provider.invalid/v1/messages", { method: "POST", body }))
          .rejects.toThrow("Numeric thinking request");
      }
      expect(fetchResponse).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock("@ai-sdk/anthropic");
      vi.resetModules();
    }
  });
});
