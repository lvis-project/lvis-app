import { afterEach, describe, expect, it, vi } from "vitest";

import { PostTurnHookChain } from "../post-turn-hook-chain.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { SettingsService } from "../../data/settings-store.js";

function createMessages(): GenericMessage[] {
  return [
    { role: "user", content: "첫 번째 요청입니다." },
    { role: "assistant", content: "첫 번째 응답입니다." },
    { role: "user", content: "두 번째 요청입니다." },
    { role: "assistant", content: "두 번째 응답입니다." },
    { role: "user", content: "세 번째 요청입니다." },
    { role: "assistant", content: "세 번째 응답입니다." },
  ];
}

describe("PostTurnHookChain", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips auto-compact when chat.autoCompact is disabled", async () => {
    const saveSession = vi.fn();
    const memoryManager = { saveSession } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn(() => ({ systemPrompt: "", autoCompact: false })),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const messages = createMessages();

    const result = await chain.run({
      sessionId: "session-disabled",
      messages,
      cumulativeUsage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
      input: "긴 대화를 이어가자",
      output: "좋아요",
      toolCalls: [],
      route: "chat",
    });

    expect(result).toBeNull();
    expect(saveSession).toHaveBeenCalledWith("session-disabled", messages);
  });

  it("compacts and saves the summarized history when chat.autoCompact is enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const memoryManager = { saveSession } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn(() => ({ systemPrompt: "", autoCompact: true })),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const messages = createMessages();

    const result = await chain.run({
      sessionId: "session-enabled",
      messages,
      cumulativeUsage: { inputTokens: 100_000, outputTokens: 0, totalTokens: 100_000 },
      input: "긴 대화를 이어가자",
      output: "좋아요",
      toolCalls: [],
      route: "chat",
    });

    expect(result).not.toBeNull();
    expect(result?.[0]?.content).toContain("[이전 대화 요약]");
    expect(saveSession).toHaveBeenCalledWith("session-enabled", result);
  });
});
