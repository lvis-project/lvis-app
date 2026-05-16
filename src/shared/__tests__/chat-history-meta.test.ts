import { describe, expect, it } from "vitest";
import { serializeHistoryMessage, type SerializedHistoryMessage } from "../chat-history.js";
import type { GenericMessage } from "../../engine/llm/types.js";

describe("serializeHistoryMessage createdAt + turnSummary projection", () => {
  it("projects meta.createdAt onto SerializedHistoryMessage.createdAt", () => {
    const m: GenericMessage = {
      role: "user",
      content: "hi",
      meta: { createdAt: 1_700_000_000_000 },
    };
    const s = serializeHistoryMessage(m, 0);
    expect(s.createdAt).toBe(1_700_000_000_000);
  });

  it("omits createdAt entirely when not set on meta", () => {
    const m: GenericMessage = { role: "user", content: "hi" };
    const s = serializeHistoryMessage(m, 0);
    expect("createdAt" in s).toBe(false);
  });

  it("projects meta.turnSummary onto SerializedHistoryMessage.turnSummary", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "answer",
      meta: {
        createdAt: 1_700_000_000_000,
        turnSummary: {
          turnDurationMs: 5000,
          toolCount: 3,
          cumulativeToolMs: 1200,
          tokensIn: 4500,
          freshInputTokens: 4200,
          tokensOut: 800,
          cacheReadTokens: 300,
        },
      },
    };
    const s = serializeHistoryMessage(m, 1);
    expect(s.turnSummary?.turnDurationMs).toBe(5000);
    expect(s.turnSummary?.freshInputTokens).toBe(4200);
    expect(s.turnSummary?.cacheReadTokens).toBe(300);
  });

  it("preserves assistant-specific fields alongside new meta fields", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "answer",
      thought: "thinking",
      toolCalls: [{ id: "t1", name: "tool_x" }],
      meta: { createdAt: 1_700_000_000_000 },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 2);
    expect(s.thought).toBe("thinking");
    expect(s.toolCalls?.[0].id).toBe("t1");
    expect(s.createdAt).toBe(1_700_000_000_000);
  });
});
