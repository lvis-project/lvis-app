import { afterEach, describe, expect, it, vi } from "vitest";

import { PostTurnHookChain } from "../post-turn-hook-chain.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { SettingsService } from "../../data/settings-store.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { EMPTY_ASSISTANT_RESPONSE_TEXT } from "../../lib/chat-stream-state.js";

function createMessages(): GenericMessage[] {
  // 16 messages — preserveRecentMessages=12 보다 커야 compactMessages 가 실제로 압축 수행.
  // 8 turn (user+assistant 쌍 × 8 = 16) 으로 새 default 와 정합.
  const out: GenericMessage[] = [];
  for (let i = 1; i <= 8; i++) {
    out.push({ role: "user", content: `${i}번째 요청입니다.` });
    out.push({ role: "assistant", content: `${i}번째 응답입니다.` });
  }
  return out;
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

  it("runs mark-stale alone (no full compact) when threshold is not met", async () => {
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

  it("detect-checkpoint: returns detector result with newTitle and checkpointSuggested", async () => {
    const saveSession = vi.fn();
    const saveSessionMetadata = vi.fn();
    const memoryManager = {
      saveSession,
      saveSessionMetadata,
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "features") return { experimentalContinuousBackend: true };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    const rawOutput = "정리 완료입니다.<title>회의 결과 요약 정리본</title>[checkpoint]";
    const result = await chain.run({
      sessionId: "session-detect",
      messages: [
        { role: "user", content: "회의 정리해줘" },
        { role: "assistant", content: rawOutput },
      ],
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "회의 정리해줘",
      output: rawOutput,
      toolCalls: [],
      route: "chat",
    });

    expect(result.detector.checkpointSuggested).toBe(true);
    expect(result.detector.newTitle).toBe("회의 결과 요약 정리본");
    expect(result.detector.cleanedText).not.toContain("<title>");
    expect(result.detector.cleanedText).not.toContain("[checkpoint]");
    expect(result.detector.cleanedText).toContain("정리 완료입니다.");
    const savedMessages = saveSession.mock.calls[0]?.[1] as GenericMessage[];
    expect(savedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: "정리 완료입니다.",
    });
  });

  it("detect-checkpoint: persists marker-only assistant output as an explicit empty response", async () => {
    const saveSession = vi.fn();
    const memoryManager = {
      saveSession,
      saveSessionMetadata: vi.fn(),
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "features") return { experimentalContinuousBackend: true };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });
    const rawOutput = "<title>제목만 생성</title>[checkpoint]";

    await chain.run({
      sessionId: "session-marker-only",
      messages: [
        { role: "user", content: "제목만 만들지 말고 저장해줘" },
        { role: "assistant", content: rawOutput },
      ],
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "제목만 만들지 말고 저장해줘",
      output: rawOutput,
      toolCalls: [],
      route: "chat",
    });

    const savedMessages = saveSession.mock.calls[0]?.[1] as GenericMessage[];
    expect(savedMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: EMPTY_ASSISTANT_RESPONSE_TEXT,
    });
  });

  it("detect-checkpoint: onCheckpointSuggested callback is invoked when marker present", async () => {
    const saveSession = vi.fn();
    const saveSessionMetadata = vi.fn();
    const onCheckpointSuggested = vi.fn();
    const memoryManager = {
      saveSession,
      saveSessionMetadata,
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "features") return { experimentalContinuousBackend: true };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService, onCheckpointSuggested });

    const result = await chain.run({
      sessionId: "session-checkpoint-cb",
      messages: createMessages(),
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "마무리",
      output: "완료.[checkpoint]",
      toolCalls: [],
      route: "chat",
    });

    expect(onCheckpointSuggested).toHaveBeenCalledOnce();
    expect(onCheckpointSuggested).toHaveBeenCalledWith("session-checkpoint-cb", result.detector.cleanedText);
  });

  it("detect-checkpoint: checkpointSuggested is false and cleanedText unchanged when no markers", async () => {
    const saveSession = vi.fn();
    const memoryManager = {
      saveSession,
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    const output = "일반 응답입니다.";
    const result = await chain.run({
      sessionId: "session-no-markers",
      messages: createMessages(),
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "질문",
      output,
      toolCalls: [],
      route: "chat",
    });

    expect(result.detector.checkpointSuggested).toBe(false);
    expect(result.detector.newTitle).toBeNull();
    expect(result.detector.cleanedText).toBe(output);
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

  it("auto-extracts memory from cleaned assistant output when stream markers are present", async () => {
    const saveMemory = vi.fn().mockResolvedValue({
      filename: "auto-memory.md",
      title: "자동-이거 기억해줘",
      content: "# 자동-이거 기억해줘\n\n...",
    });
    const memoryManager = {
      saveSession: vi.fn(),
      saveMemory,
      saveSessionMetadata: vi.fn(),
      loadSessionMetadata: vi.fn().mockReturnValue(null),
    } as unknown as MemoryManager;
    const settingsService = {
      get: vi.fn((key: string) => {
        if (key === "llm") return fakeLlmSettings();
        if (key === "features") return { experimentalContinuousBackend: true };
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    await chain.run({
      sessionId: "session-memory-cleaned",
      messages: createMessages(),
      cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
      input: "이거 기억해줘",
      output: "네, 기억하겠습니다.<title>기억 저장 테스트 제목</title>[checkpoint]",
      toolCalls: [],
      route: "chat",
    });

    const savedBody = saveMemory.mock.calls[0]?.[1] as string;
    expect(savedBody).toContain("네, 기억하겠습니다.");
    expect(savedBody).not.toContain("<title>");
    expect(savedBody).not.toContain("[checkpoint]");
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

    it("logs cleaned output when stream markers are present", async () => {
      const logTurn = vi.fn();
      const auditLogger = { logTurn } as unknown as import("../../audit/audit-logger.js").AuditLogger;
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") return fakeLlmSettings();
          if (key === "features") return { experimentalContinuousBackend: true };
          return { systemPrompt: "", autoCompact: false };
        }),
      } as unknown as SettingsService;
      const chain = new PostTurnHookChain({ auditLogger, settingsService });

      await chain.run({
        sessionId: "session-audit-cleaned",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "정리",
        output: "정리 완료입니다.<title>감사 로그 테스트 제목</title>",
        toolCalls: [],
        route: "chat",
      });

      const call = logTurn.mock.calls[0]![0] as { output: string };
      expect(call.output).toBe("정리 완료입니다.");
    });
  });

  describe("safety flag: experimentalContinuousBackend OFF", () => {
    it("detect-checkpoint step is skipped when flag is OFF — checkpointSuggested stays false", async () => {
      const onCheckpointSuggested = vi.fn();
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") return fakeLlmSettings();
          if (key === "features") return { experimentalContinuousBackend: false };
          return { systemPrompt: "", autoCompact: false };
        }),
      } as unknown as SettingsService;
      const chain = new PostTurnHookChain({
        memoryManager: {
          saveSession: vi.fn(),
          loadSessionMetadata: vi.fn().mockReturnValue(null),
        } as unknown as MemoryManager,
        settingsService,
        onCheckpointSuggested,
      });

      const result = await chain.run({
        sessionId: "session-flag-off",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "테스트",
        output: "응답 완료입니다.<title>테스트 제목</title>[checkpoint]",
        toolCalls: [],
        route: "chat",
      });

      // Flag OFF: detector not invoked, returns default values, callback not called.
      expect(result.detector.checkpointSuggested).toBe(false);
      expect(result.detector.newTitle).toBeNull();
      // cleanedText stays as raw output (not stripped) since detect was skipped
      expect(result.detector.cleanedText).toContain("[checkpoint]");
      expect(onCheckpointSuggested).not.toHaveBeenCalled();
    });

    it("update-title step is skipped when flag is OFF — saveSessionMetadata not called", async () => {
      const saveSessionMetadata = vi.fn();
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") return fakeLlmSettings();
          if (key === "features") return { experimentalContinuousBackend: false };
          return { systemPrompt: "", autoCompact: false };
        }),
      } as unknown as SettingsService;
      const chain = new PostTurnHookChain({
        memoryManager: {
          saveSession: vi.fn(),
          saveSessionMetadata,
          loadSessionMetadata: vi.fn().mockReturnValue(null),
        } as unknown as MemoryManager,
        settingsService,
      });

      await chain.run({
        sessionId: "session-no-title",
        messages: createMessages(),
        cumulativeUsage: { inputTokens: 100, outputTokens: 0 },
        input: "테스트",
        output: "응답 완료입니다.<title>어떤 제목</title>",
        toolCalls: [],
        route: "chat",
      });

      // Flag OFF: saveSessionMetadata must not be called for title update.
      expect(saveSessionMetadata).not.toHaveBeenCalled();
    });
  });
});
