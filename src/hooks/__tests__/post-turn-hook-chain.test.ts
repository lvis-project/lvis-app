import { afterEach, describe, expect, it, vi } from "vitest";

import { PostTurnHookChain } from "../post-turn-hook-chain.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { SettingsService } from "../../data/settings-store.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

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
        if (key === "llm") return fakeLlmSettings();
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

    expect(result.compactedMessages).toBeNull();
    expect(saveSession).toHaveBeenCalledWith("session-disabled", messages);
  });

  it("compacts and saves the summarized history when chat.autoCompact is enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const memoryManager = {
      saveSession,
      listSessions: vi.fn().mockReturnValue([]),
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
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

    expect(result.compactedMessages).not.toBeNull();
    // 요약 marker는 배열 어딘가에 존재
    const marker = result.compactedMessages?.find((m) => m.role === "user" && m.meta?.compactBoundary === true);
    expect(marker).toBeDefined();
    expect(marker?.content).toContain("[이전 대화 요약]");
    expect(saveSession).toHaveBeenCalledWith("session-enabled", result.compactedMessages);
  });

  it("runs microcompact alone (no full compact) when threshold is not met", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const memoryManager = {
      saveSession,
      listSessions: vi.fn().mockReturnValue([]),
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
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

    expect(result.compactedMessages).not.toBeNull();
    // full-compact 요약 marker는 없어야 함
    const marker = result.compactedMessages?.find((m) => m.role === "user" && m.meta?.compactBoundary === true);
    expect(marker).toBeUndefined();
    // 하지만 stripped 메시지는 존재
    const strippedCount = result.compactedMessages?.filter((m) => m.role === "tool_result" && m.meta?.stripped === true).length ?? 0;
    expect(strippedCount).toBeGreaterThan(0);
    expect(saveSession).toHaveBeenCalledWith("session-micro", result.compactedMessages);
  });

  it("auto-extracts user memory into saveMemory when the user asks to remember something", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const saveSession = vi.fn();
    const saveMemory = vi.fn().mockResolvedValue({
      filename: "auto-memory.md",
      title: "자동-이거 기억해줘",
      content: "# 자동-이거 기억해줘\n\n...",
    });
    const memoryManager = {
      saveSession,
      saveMemory,
      listSessions: vi.fn().mockReturnValue([]),
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
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
  });

  describe("audit route emission", () => {
    function makeChain(opts: { autoCompact: boolean; logTurn: ReturnType<typeof vi.fn> }) {
      const auditLogger = { logTurn: opts.logTurn } as unknown as import("../../audit/audit-logger.js").AuditLogger;
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") return fakeLlmSettings();
          return { systemPrompt: "", autoCompact: opts.autoCompact };
        }),
      } as unknown as SettingsService;
      return new PostTurnHookChain({ auditLogger, settingsService });
    }

    it("emits `${provider}/${model}` for llm-route turns", async () => {
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-llm",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "안녕",
        output: "반갑습니다",
        toolCalls: [],
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        route: "llm",
      });

      // Audit route should be transformed from the bare classification
      // "llm" into the `${provider}/${model}` form so usage-stats.parseRoute
      // can attribute cost per vendor/model. The exact provider/model
      // depends on what `fakeLlmSettings()` seeds — assert structural
      // shape (`vendor/model`) rather than a specific vendor.
      expect(logTurn).toHaveBeenCalledOnce();
      const call = logTurn.mock.calls[0]![0] as { route: string };
      expect(call.route).toMatch(/^[a-z][\w-]*\/[\w.-]+$/);
      expect(call.route).not.toBe("llm");
    });

    it("emits the bare classification for non-llm routes", async () => {
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-skill",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "/help",
        output: "...",
        toolCalls: [],
        route: "skill",
      });

      const call = logTurn.mock.calls[0]![0] as { route: string };
      expect(call.route).toBe("skill");
    });

    it("prefers ctx.vendorProvider/vendorModel snapshot over current settings", async () => {
      // Regression: when the user mutates settings mid-flight (retry-effort
      // patches thinking config; user switches vendor while streaming),
      // the audit log must attribute to the model that actually served
      // the turn, not to whatever settings happen to be live when the
      // hook fires. The snapshot is captured at runTurn entry.
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-snapshot",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "안녕",
        output: "반갑습니다",
        toolCalls: [],
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        route: "llm",
        vendorProvider: "claude",
        vendorModel: "claude-3-5-sonnet-20241022",
      });

      const call = logTurn.mock.calls[0]![0] as { route: string };
      expect(call.route).toBe("claude/claude-3-5-sonnet-20241022");
    });
  });
});
