import { describe, it, expect } from "vitest";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { classifyTurnEntries, isTurnStartEntry } from "../utils/classify-turn-entries.js";

const user = (text: string): ChatEntry => ({ kind: "user", text });
const assistant = (text: string, extra: Partial<Extract<ChatEntry, { kind: "assistant" }>> = {}): ChatEntry => ({
  kind: "assistant",
  text,
  ...extra,
});
const toolGroup = (): ChatEntry => ({
  kind: "tool_group",
  groupId: "g",
  groupIds: ["g"],
  status: "done",
  tools: [{ toolUseId: "t1", name: "x", displayOrder: 0, status: "done" }],
});

describe("isTurnStartEntry", () => {
  it("is true for user and imported_trigger, false otherwise", () => {
    expect(isTurnStartEntry({ kind: "user", text: "" })).toBe(true);
    expect(
      isTurnStartEntry({
        kind: "imported_trigger",
        sessionId: "s",
        source: "o",
        prompt: "p",
        summary: "sum",
        toolCallCount: 0,
        importedAt: "2026-01-01",
      }),
    ).toBe(true);
    expect(isTurnStartEntry({ kind: "assistant", text: "" })).toBe(false);
    expect(isTurnStartEntry(undefined)).toBe(false);
  });
});

describe("classifyTurnEntries", () => {
  it("marks the last completed assistant as final (non-streaming)", () => {
    const entries: ChatEntry[] = [user("q"), assistant("a")];
    const { lastTurnStartIdx, entryClassMap, finalTurnStartMap } = classifyTurnEntries(entries, false);
    expect(lastTurnStartIdx).toBe(0);
    expect(entryClassMap.get(1)).toBe("final");
    expect(finalTurnStartMap.get(1)).toBe(0);
  });

  it("collapses mid-turn work to intermediate, final answer stays final", () => {
    const entries: ChatEntry[] = [user("q"), toolGroup(), assistant("done")];
    const { entryClassMap, entryTurnStartMap } = classifyTurnEntries(entries, false);
    expect(entryClassMap.get(1)).toBe("intermediate"); // tool_group has subsequent assistant
    expect(entryClassMap.get(2)).toBe("final");
    expect(entryTurnStartMap.get(1)).toBe(0);
    expect(entryTurnStartMap.get(2)).toBe(0);
  });

  it("keeps the active streaming assistant as intermediate (no TurnActionBar)", () => {
    const entries: ChatEntry[] = [user("q"), assistant("partial")];
    const { entryClassMap, finalTurnStartMap } = classifyTurnEntries(entries, true);
    expect(entryClassMap.get(1)).toBe("intermediate");
    expect(finalTurnStartMap.has(1)).toBe(false);
  });

  it("assigns each entry to its owning turn-start across multiple turns", () => {
    const entries: ChatEntry[] = [user("q1"), assistant("a1"), user("q2"), assistant("a2")];
    const { lastTurnStartIdx, entryTurnStartMap, entryClassMap } = classifyTurnEntries(entries, false);
    expect(lastTurnStartIdx).toBe(2);
    expect(entryTurnStartMap.get(1)).toBe(0);
    expect(entryTurnStartMap.get(3)).toBe(2);
    expect(entryClassMap.get(1)).toBe("final");
    expect(entryClassMap.get(3)).toBe("final");
  });
});
