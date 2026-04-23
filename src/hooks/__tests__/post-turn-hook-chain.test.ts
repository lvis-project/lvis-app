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
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", model: "gpt-4o" };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const messages = createMessages();

    const result = await chain.run({
      sessionId: "session-disabled",
      messages,
      cumulativeUsage: { inputTokens: 120_000, outputTokens: 0 },
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
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", model: "gpt-4o" };
        return { systemPrompt: "", autoCompact: true };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const messages = createMessages();

    const result = await chain.run({
      sessionId: "session-enabled",
      messages,
      cumulativeUsage: { inputTokens: 120_000, outputTokens: 0 },
      input: "긴 대화를 이어가자",
      output: "좋아요",
      toolCalls: [],
      route: "chat",
    });

    expect(result).not.toBeNull();
    // 요약 marker는 배열 어딘가에 존재
    const marker = result?.find((m) => m.role === "user" && m.meta?.compactBoundary === true);
    expect(marker).toBeDefined();
    expect(marker?.content).toContain("[이전 대화 요약]");
    expect(saveSession).toHaveBeenCalledWith("session-enabled", result);
  });

  it("runs microcompact alone (no full compact) when threshold is not met", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const memoryManager = { saveSession } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", model: "gpt-4o" };
        return { systemPrompt: "", autoCompact: true };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    // 10개 tool_result가 있는 히스토리 — 미세압축은 6개 strip, 임계치는 미달
    const messages: GenericMessage[] = [{ role: "user", content: "시작" }];
    for (let i = 0; i < 10; i++) {
      const id = `t${i}`;
      messages.push({
        role: "assistant",
        content: `s${i}`,
        toolCalls: [{ id, name: "search", input: { q: `q${i}` } }],
      });
      messages.push({
        role: "tool_result",
        toolUseId: id,
        toolName: "search",
        content: "y".repeat(3000),
      });
    }

    const result = await chain.run({
      sessionId: "session-micro",
      messages,
      cumulativeUsage: { inputTokens: 1_000, outputTokens: 0 }, // 임계치 훨씬 아래
      input: "검색",
      output: "ok",
      toolCalls: [],
      route: "chat",
    });

    expect(result).not.toBeNull();
    // full-compact 요약 marker는 없어야 함
    const marker = result?.find((m) => m.role === "user" && m.meta?.compactBoundary === true);
    expect(marker).toBeUndefined();
    // 하지만 stripped 메시지는 존재
    const strippedCount = result?.filter((m) => m.role === "tool_result" && m.meta?.stripped === true).length ?? 0;
    expect(strippedCount).toBeGreaterThan(0);
    expect(saveSession).toHaveBeenCalledWith("session-micro", result);
  });

  it("auto-extracts user memory into saveMemory when the user asks to remember something", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const saveMemory = vi.fn().mockResolvedValue({
      filename: "auto-memory.md",
      title: "자동-이거 기억해줘",
      content: "# 자동-이거 기억해줘\n\n...",
    });
    const saveNote = vi.fn();
    const memoryManager = { saveSession, saveMemory, saveNote } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return { provider: "openai", model: "gpt-4o" };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    await chain.run({
      sessionId: "session-memory",
      messages: createMessages(),
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "이거 기억해줘",
      output: "네, 기억하겠습니다.",
      toolCalls: [],
      route: "chat",
    });

    expect(saveMemory).toHaveBeenCalledOnce();
    expect(saveNote).not.toHaveBeenCalled();
  });
});
