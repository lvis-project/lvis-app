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

  it("preserves systemNotice marker through serialization (Issue #911)", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "대화 이력이 모델 한도를 초과했습니다.",
      meta: { systemNotice: "context-error" },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 3);
    expect(s.systemNotice).toBe("context-error");
  });

  it("omits systemNotice field when meta has no marker", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "normal reply",
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 4);
    expect(s.systemNotice).toBeUndefined();
  });

  it("projects checkpoint compactNum through serialization", () => {
    const m: GenericMessage = {
      role: "user",
      content: "[compact boundary]",
      meta: {
        checkpointMeta: {
          removedMessages: 37,
          freedTokens: 1200,
          compactNum: 4,
          trigger: "auto-compact",
        },
      },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 5);
    expect(s.checkpointMeta?.compactNum).toBe(4);
  });
});
