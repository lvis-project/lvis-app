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
      input: "긴 대화를 이어가자",
      output: "좋아요",
      toolCalls: [],
      route: "chat",
    });

    expect(result.compactedMessages).toBeNull();
    expect(saveSession).toHaveBeenCalledWith("session-disabled", messages);
  });

  // Post-turn full compact 가 제거됐으므로 *PostTurnHookChain 안에서*
  // boundary marker 생성 시나리오 자체 폐기. 동등 검증은 `runPreflightGuard` 의 LLM compact 경로
  // (engine 통합 테스트) 에서 다뤄짐 — `structured-compact.test.ts:compactWithBoundary` 참조.

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
      input: "검색",
      output: "ok",
      toolCalls: [],
      route: "chat",
    });

    expect(result.compactedMessages).not.toBeNull();
    // full-compact 요약 marker 는 없음 (mark-stale 만 실행됨)
    const marker = result.compactedMessages?.find((m) => m.role === "user" && m.meta?.compactBoundary === true);
    expect(marker).toBeUndefined();
    // 마킹된 (compactedAt set) tool_result 가 *memory 에서는 verbatim*
    const marked = result.compactedMessages?.filter((m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined) ?? [];
    expect(marked.length).toBeGreaterThan(0);
    for (const m of marked) {
      if (m.role === "tool_result") {
        // memory 의 content 는 *원본 그대로* (3000자) — saveSession 이 직렬화 시 stub/artifact 처리
        expect(m.content.length).toBeGreaterThan(2000);
        expect(m.content).not.toContain("[tool_result stripped");
      }
    }
    // saveSession 은 raw marked history 를 받고, MemoryManager.saveSession 이
    // JSONL stub + file-backed artifact 직렬화를 담당한다.
    expect(saveSession).toHaveBeenCalledTimes(1);
    const persisted = saveSession.mock.calls[0]?.[1] as GenericMessage[];
    expect(persisted).toBeDefined();
    const persistedMarked = persisted.filter((m) => m.role === "tool_result" && m.meta?.compactedAt !== undefined);
    expect(persistedMarked.length).toBeGreaterThan(0);
    for (const m of persistedMarked) {
      if (m.role === "tool_result") {
        expect(m.content.length).toBeGreaterThan(2000);
        expect(m.content).not.toContain("[tool_result stripped");
      }
    }
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
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService, onCheckpointSuggested });

    const result = await chain.run({
      sessionId: "session-checkpoint-cb",
      messages: createMessages(),
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
        return { systemPrompt: "", autoCompact: false };
      }),
    } as unknown as SettingsService;
    const chain = new PostTurnHookChain({ memoryManager, settingsService });

    await chain.run({
      sessionId: "session-memory-cleaned",
      messages: createMessages(),
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
        input: "/help",
        output: "...",
        toolCalls: [],
        route: "skill",
      });

      const call = logTurn.mock.calls[0]![0] as { route: string };
      expect(call.route).toBe("skill");
    });

    it("emits serving provider/model for token-bearing skill routes", async () => {
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-skill-llm",
        messages: createMessages(),
        input: "메일 읽어줘",
        output: "확인했습니다",
        toolCalls: [],
        route: "skill",
        tokenUsage: { inputTokens: 100, outputTokens: 50 },
        vendorProvider: "openai",
        vendorModel: "gpt-5.4-mini",
      });

      const call = logTurn.mock.calls[0]![0] as { route: string };
      expect(call.route).toBe("openai/gpt-5.4-mini");
    });

    it("persists per-model usage breakdown for mixed fallback rounds", async () => {
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-mixed-fallback",
        messages: createMessages(),
        input: "여러 라운드",
        output: "완료",
        toolCalls: [],
        route: "llm",
        tokenUsage: { inputTokens: 1_700_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 200_000 },
        usageByModel: [
          {
            vendorProvider: "claude",
            vendorModel: "claude-sonnet-4-6",
            tokenUsage: { inputTokens: 1_700_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 200_000 },
          },
          {
            vendorProvider: "openai",
            vendorModel: "gpt-5.4-mini",
            tokenUsage: { inputTokens: 10_000, outputTokens: 1_000 },
          },
        ],
        vendorProvider: "openai",
        vendorModel: "gpt-5.4-mini",
      });

      const call = logTurn.mock.calls[0]![0] as {
        usageByModel: Array<{
          vendorProvider: string;
          vendorModel: string;
          tokenUsage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
        }>;
      };
      expect(call.usageByModel).toEqual([
        {
          vendorProvider: "claude",
          vendorModel: "claude-sonnet-4-6",
          tokenUsage: {
            inputTokens: 1_000_000,
            outputTokens: 100_000,
            cacheReadTokens: 500_000,
            cacheWriteTokens: 200_000,
          },
        },
        {
          vendorProvider: "openai",
          vendorModel: "gpt-5.4-mini",
          tokenUsage: { inputTokens: 10_000, outputTokens: 1_000 },
        },
      ]);
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

    it("normalizes Claude AI SDK total input to fresh input before audit logging", async () => {
      const logTurn = vi.fn();
      const chain = makeChain({ autoCompact: false, logTurn });

      await chain.run({
        sessionId: "session-claude-cache",
        messages: createMessages(),
        input: "캐시 사용량 확인",
        output: "확인했습니다",
        toolCalls: [],
        tokenUsage: {
          inputTokens: 1_700_000,
          outputTokens: 100_000,
          cacheReadTokens: 500_000,
          cacheWriteTokens: 200_000,
        },
        route: "llm",
        vendorProvider: "claude",
        vendorModel: "claude-sonnet-4-6",
      });

      expect(logTurn).toHaveBeenCalledOnce();
      const call = logTurn.mock.calls[0]![0] as {
        tokenUsage: {
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      };
      expect(call.tokenUsage).toEqual({
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 500_000,
        cacheWriteTokens: 200_000,
      });
    });

    it("logs cleaned output when stream markers are present", async () => {
      const logTurn = vi.fn();
      const auditLogger = { logTurn } as unknown as import("../../audit/audit-logger.js").AuditLogger;
      const settingsService = {
        get: vi.fn((key: string) => {
          if (key === "llm") return fakeLlmSettings();
          return { systemPrompt: "", autoCompact: false };
        }),
      } as unknown as SettingsService;
      const chain = new PostTurnHookChain({ auditLogger, settingsService });

      await chain.run({
        sessionId: "session-audit-cleaned",
        messages: createMessages(),
        input: "정리",
        output: "정리 완료입니다.<title>감사 로그 테스트 제목</title>",
        toolCalls: [],
        route: "chat",
      });

      const call = logTurn.mock.calls[0]![0] as { output: string };
      expect(call.output).toBe("정리 완료입니다.");
    });
  });

});
