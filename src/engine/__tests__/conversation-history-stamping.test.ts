import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { ConversationHistory } from "../conversation-history.js";
import type { GenericMessage } from "../llm/types.js";

describe("ConversationHistory createdAt stamping", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps meta.createdAt with Date.now() when appending a fresh message", () => {
    const h = new ConversationHistory();
    h.append({ role: "user", content: "hi" });
    const msg = h.getMessages()[0];
    expect(msg.meta?.createdAt).toBe(new Date("2026-05-17T10:00:00.000Z").getTime());
  });

  it("preserves an explicit createdAt when one is already present", () => {
    const h = new ConversationHistory();
    const originalTime = new Date("2026-05-16T03:00:00.000Z").getTime();
    h.append({ role: "assistant", content: "hello", meta: { createdAt: originalTime } });
    const msg = h.getMessages()[0];
    expect(msg.meta?.createdAt).toBe(originalTime);
  });

  it("preserves other meta fields when stamping createdAt", () => {
    const h = new ConversationHistory();
    h.append({
      role: "tool_result",
      toolUseId: "t1",
      content: "ok",
      meta: { lock: true },
    });
    const msg = h.getMessages()[0];
    expect(msg.meta?.lock).toBe(true);
    expect(msg.meta?.createdAt).toBeDefined();
  });
});

describe("ConversationHistory.attachToLastAssistant", () => {
  it("mutates the most recent assistant message's meta", () => {
    const h = new ConversationHistory();
    h.append({ role: "user", content: "q" });
    h.append({ role: "assistant", content: "a" });
    h.attachToLastAssistant({
      turnSummary: {
        turnDurationMs: 1234,
        toolCount: 2,
        cumulativeToolMs: 567,
        tokensIn: 1000,
        freshInputTokens: 800,
        tokensOut: 50,
      },
    });
    const last = h.getMessages()[1];
    expect(last.meta?.turnSummary?.turnDurationMs).toBe(1234);
    expect(last.meta?.turnSummary?.tokensOut).toBe(50);
  });

  it("no-ops when there is no assistant message yet", () => {
    const h = new ConversationHistory();
    h.append({ role: "user", content: "q" });
    expect(() => h.attachToLastAssistant({ turnSummary: {
      turnDurationMs: 0, toolCount: 0, cumulativeToolMs: 0,
      tokensIn: 0, freshInputTokens: 0, tokensOut: 0,
    } })).not.toThrow();
    // user message should still NOT have turnSummary
    expect(h.getMessages()[0].meta?.turnSummary).toBeUndefined();
  });

  it("attaches to the last assistant when interleaved with later non-assistant", () => {
    const h = new ConversationHistory();
    h.append({ role: "user", content: "q1" });
    h.append({ role: "assistant", content: "a1" });
    h.append({ role: "tool_result", toolUseId: "t1", content: "ok" });
    h.append({ role: "assistant", content: "a2" });
    h.attachToLastAssistant({ createdAt: 42 });
    const messages = h.getMessages();
    // First assistant retains its original createdAt (auto-stamped on append).
    expect(messages[1].meta?.createdAt).not.toBe(42);
    // Last assistant got the mutation.
    expect(messages[3].meta?.createdAt).toBe(42);
  });
});

describe("ConversationHistory.restore preserves original createdAt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-17T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT re-stamp createdAt on disk-loaded messages", () => {
    const persisted: GenericMessage[] = [
      { role: "user", content: "old q", meta: { createdAt: 1_000_000_000_000 } },
      { role: "assistant", content: "old a", meta: { createdAt: 1_000_000_001_000 } },
    ];
    const h = new ConversationHistory();
    h.restore(persisted);
    const messages = h.getMessages();
    expect(messages[0].meta?.createdAt).toBe(1_000_000_000_000);
    expect(messages[1].meta?.createdAt).toBe(1_000_000_001_000);
  });

  it("leaves createdAt undefined for legacy persisted messages without it", () => {
    const persisted: GenericMessage[] = [
      { role: "user", content: "old q" },
    ];
    const h = new ConversationHistory();
    h.restore(persisted);
    // Legacy messages — undefined stays undefined. UI renders nothing
    // rather than fake the load time.
    expect(h.getMessages()[0].meta?.createdAt).toBeUndefined();
  });
});
