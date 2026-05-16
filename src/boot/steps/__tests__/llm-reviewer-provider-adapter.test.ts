/**
 * Unit tests for `LlmReviewerProviderAdapter` (#767).
 *
 * The adapter is the only execution path for `openai` / `anthropic` /
 * `google` / `foundry` / `gcp-playground` reviewer providers — it
 * collapses an LLM provider's `streamTurn` async iterator into the
 * one-shot `complete()` shape that the reviewer pipeline expects.
 *
 * Without unit coverage, any change to the stream-event handling (e.g.
 * adding a new event kind, changing the abort semantics, renaming the
 * usage shape) silently breaks every reviewer call. This file pins:
 *
 *   1. text_delta accumulation across multiple chunks
 *   2. message_complete usage forwarding (inputTokens / outputTokens)
 *   3. message_complete without usage → returns 0 tokens (tolerant)
 *   4. error event → throws with the provider error message
 *   5. mid-stream abort → throws "reviewer LLM call aborted"
 *   6. reasoning_delta / tool_call events ignored (not concatenated)
 *
 * Each contract is verified across all 6 supported vendor strings so that
 * adding a new vendor to LLM_VENDORS without updating the adapter surfaces
 * here rather than in production (#767 vendor-breadth requirement).
 */
import { describe, it, expect } from "vitest";
import { LlmReviewerProviderAdapter } from "../reviewer-wiring.js";
import type {
  LLMProvider,
  StreamEvent,
  StreamTurnParams,
} from "../../../engine/llm/types.js";

const VENDORS = [
  "openai",
  "claude",
  "gemini",
  "copilot",
  "azure-foundry",
  "vertex-ai",
] as const;

type Vendor = (typeof VENDORS)[number];

function makeStreamProvider(events: StreamEvent[], vendor: Vendor = "openai"): LLMProvider {
  return {
    vendor,
    streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
      return {
        async *[Symbol.asyncIterator]() {
          for (const e of events) yield e;
        },
      };
    },
  };
}

describe.each(VENDORS)("LlmReviewerProviderAdapter [vendor=%s]", (vendor) => {
  it("accumulates text_delta chunks into the final text", async () => {
    const provider = makeStreamProvider(
      [
        { type: "text_delta", text: '{"level":"' },
        { type: "text_delta", text: "low" },
        { type: "text_delta", text: '","reason":"safe"}' },
        {
          type: "message_complete",
          stopReason: "end_turn",
          usage: { inputTokens: 120, outputTokens: 30 },
        },
      ],
      vendor,
    );
    const adapter = new LlmReviewerProviderAdapter(provider);

    const result = await adapter.complete({
      model: "gpt-5",
      systemPrompt: "system",
      userPrompt: "user",
    });

    expect(result.text).toBe('{"level":"low","reason":"safe"}');
    expect(result.tokensIn).toBe(120);
    expect(result.tokensOut).toBe(30);
    expect(result.costUsd).toBe(0);
  });

  it("returns zero tokens when message_complete carries no usage", async () => {
    const provider = makeStreamProvider(
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      vendor,
    );
    const adapter = new LlmReviewerProviderAdapter(provider);

    const result = await adapter.complete({
      model: "gpt-5",
      systemPrompt: "s",
      userPrompt: "u",
    });

    expect(result.text).toBe("ok");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  it("throws on error events with the provider error message", async () => {
    const provider = makeStreamProvider(
      [
        { type: "text_delta", text: "partial" },
        { type: "error", error: "upstream 429 rate-limit" },
      ],
      vendor,
    );
    const adapter = new LlmReviewerProviderAdapter(provider);

    await expect(
      adapter.complete({ model: "gpt-5", systemPrompt: "s", userPrompt: "u" }),
    ).rejects.toThrow(/reviewer provider error: upstream 429 rate-limit/);
  });

  it("throws when aborted mid-stream", async () => {
    const controller = new AbortController();
    const provider: LLMProvider = {
      vendor,
      streamTurn(): AsyncIterable<StreamEvent> {
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", text: "first" };
            // Caller aborts between chunks.
            controller.abort();
            yield { type: "text_delta", text: "second" };
          },
        };
      },
    };
    const adapter = new LlmReviewerProviderAdapter(provider);

    await expect(
      adapter.complete({
        model: "gpt-5",
        systemPrompt: "s",
        userPrompt: "u",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow(/reviewer LLM call aborted/);
  });

  it("ignores reasoning_delta and tool_call events", async () => {
    const provider = makeStreamProvider(
      [
        { type: "reasoning_delta", text: "thinking aloud..." },
        { type: "text_delta", text: "real" },
        {
          type: "tool_call",
          id: "t1",
          name: "stray_tool",
          input: { x: 1 },
        },
        { type: "text_delta", text: " answer" },
        {
          type: "message_complete",
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ],
      vendor,
    );
    const adapter = new LlmReviewerProviderAdapter(provider);

    const result = await adapter.complete({
      model: "gpt-5",
      systemPrompt: "s",
      userPrompt: "u",
    });

    expect(result.text).toBe("real answer");
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(5);
  });

  it("forwards systemPrompt + userPrompt + model + abortSignal to the provider streamTurn call", async () => {
    const captured: StreamTurnParams[] = [];
    const controller = new AbortController();
    const provider: LLMProvider = {
      vendor,
      streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
        captured.push(params);
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", text: "x" };
            yield { type: "message_complete", stopReason: "end_turn" };
          },
        };
      },
    };
    const adapter = new LlmReviewerProviderAdapter(provider);

    await adapter.complete({
      model: "claude-sonnet-4-6",
      systemPrompt: "reviewer-system",
      userPrompt: "reviewer-user",
      abortSignal: controller.signal,
    });

    expect(captured).toHaveLength(1);
    const params = captured[0];
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.systemPrompt).toBe("reviewer-system");
    expect(params.messages).toEqual([
      { role: "user", content: "reviewer-user" },
    ]);
    expect(params.abortSignal).toBe(controller.signal);
  });
});
