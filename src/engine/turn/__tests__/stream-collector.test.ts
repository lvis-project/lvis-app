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
  constructor(private readonly events: readonly StreamEvent[]) {}

  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
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
