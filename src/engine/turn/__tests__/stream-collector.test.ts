import { describe, expect, it } from "vitest";

import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { collectRoundStream } from "../stream-collector.js";

const LLM_SETTINGS = {
  streamSmoothing: "none" as const,
  enableThinking: false,
  thinkingBudgetTokens: 0,
};

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  /** Recorded so a test can assert what actually crossed the wire. */
  lastParams: StreamTurnParams | null = null;
  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}


class SubscriptionCapturingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly subscriptionRuntime = { kind: "subscription", provider: "codex" } as const;
  lastParams: StreamTurnParams | null = null;

  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.lastParams = params;
    yield* this.events;
  }
}

async function collect(events: readonly StreamEvent[]) {
  return collectRoundStream({
    provider: new ScriptedProvider(events),
    model: "test-model",
    systemPrompt: "system",
    messages: [],
    toolSchemas: [],
    llmSettings: LLM_SETTINGS,
  });
}

describe("collectRoundStream tool call IDs", () => {
  it("forwards thinking controls to a marked subscription runtime", async () => {
    const provider = new SubscriptionCapturingProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);

    await collectRoundStream({
      provider,
      model: "subscription-model",
      systemPrompt: "subscription-system",
      messages: [],
      toolSchemas: [],
      llmSettings: {
        streamSmoothing: "none",
        enableThinking: true,
        thinkingBudgetTokens: 10_000,
      },
    });

    expect(provider.lastParams).toMatchObject({
      enableThinking: true,
      thinkingBudgetTokens: 10_000,
    });
  });

  it.each([
    ["empty", ""],
    ["over UTF-8 byte limit", "😀".repeat(65)],
    ["NUL", "raw-secret\u0000invalid-id"],
    ["C0", "raw-secret\ninvalid-id"],
    ["C1", "raw-secret\u0085invalid-id"],
  ])("rejects an %s ID without exposing it or tool input", async (_label, id) => {
    const result = await collect([
      {
        type: "tool_call",
        id,
        name: "bash",
        input: { command: "raw-secret-tool-input" },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "stream_error",
      classification: "unknown",
      providerError: {
        messagePreview: "invalid tool_call id in assistant response",
      },
    });
    expect(JSON.stringify(result)).not.toContain("raw-secret");
    expect(result).not.toHaveProperty("toolCalls");
  });

  it("accepts a valid tool event from a subscription runtime", async () => {
    const provider = new SubscriptionCapturingProvider([
      {
        type: "tool_call",
        id: "subscription-tool",
        name: "read_file",
        input: { path: "src/index.ts" },
      },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    const result = await collectRoundStream({
      provider,
      model: "subscription-model",
      systemPrompt: "subscription-system",
      messages: [],
      toolSchemas: [],
      llmSettings: LLM_SETTINGS,
    });

    expect(result).toMatchObject({
      kind: "ok",
      stopReason: "tool_use",
      toolCalls: [{
        id: "subscription-tool",
        name: "read_file",
        input: { path: "src/index.ts" },
      }],
    });
  });

  it("accepts a distinct ID at exactly 256 UTF-8 bytes", async () => {
    const id = "😀".repeat(64);
    const result = await collect([
      { type: "tool_call", id, name: "read_file", input: { path: "one" } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "ok",
      toolCalls: [{ id, name: "read_file", input: { path: "one" } }],
    });
  });

  it("rejects duplicate IDs without exposing tool inputs in diagnostics", async () => {
    const secret = "raw-secret-tool-input";
    const result = await collect([
      { type: "tool_call", id: "duplicate", name: "read_file", input: { path: "safe" } },
      { type: "tool_call", id: "duplicate", name: "bash", input: { command: secret } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "stream_error",
      classification: "unknown",
      providerError: {
        origin: "unknown",
        classification: "unknown",
        messagePreview: "duplicate tool_call id in one assistant response",
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty("toolCalls");
  });

  it("preserves distinct tool calls in provider order", async () => {
    const result = await collect([
      { type: "tool_call", id: "first", name: "read_file", input: { path: "one" } },
      { type: "tool_call", id: "second", name: "bash", input: { command: "pwd" } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);

    expect(result).toMatchObject({
      kind: "ok",
      stopReason: "tool_use",
      toolCalls: [
        { id: "first", name: "read_file", input: { path: "one" } },
        { id: "second", name: "bash", input: { command: "pwd" } },
      ],
    });
  });
});
describe("per-vendor output ceiling", () => {
  // Some gateways pre-authorize credit against the MODEL's maximum output, not
  // the tokens produced: OpenRouter answers 402 "requires more credits, or
  // fewer max_tokens" when a capped key cannot afford the full ceiling, so such
  // a key cannot start any turn. Setting a ceiling is the way out; the adapter
  // already maps `outputTokenLimit` to the request's native limit.
  it("forwards a configured ceiling to the provider", async () => {
    const provider = new ScriptedProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await collectRoundStream({
      provider,
      model: "test-model",
      systemPrompt: "system",
      messages: [],
      toolSchemas: [],
      llmSettings: { ...LLM_SETTINGS, outputTokenLimit: 2048 },
    });
    expect(provider.lastParams?.outputTokenLimit).toBe(2048);
  });

  it("sends nothing when no ceiling is configured", async () => {
    const provider = new ScriptedProvider([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    await collectRoundStream({
      provider,
      model: "test-model",
      systemPrompt: "system",
      messages: [],
      toolSchemas: [],
      llmSettings: LLM_SETTINGS,
    });
    // Default stays CTRL policy — vendor SDK defaults govern.
    expect(provider.lastParams).not.toHaveProperty("outputTokenLimit");
  });
});
