import { describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { PostTurnHookChain } from "../../hooks/post-turn-hook-chain.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function createLoopWithRegistry(
  provider: FakeProvider,
  toolRegistry: ToolRegistry,
  overrides: Partial<ConstructorParameters<typeof ConversationLoop>[0]> = {},
): ConversationLoop {
  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
    ...overrides,
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationLoop onTurnSummary", () => {
  it("emits the aggregate footer with step count, token usage, and per-tool breakdown", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async () => ({ output: "src\npackage.json", isError: false }),
    }));
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }));

    // Round 1: 2 tools (list_directory + read_file in parallel),
    // Round 2: 1 tool (read_file again),
    // Round 3: end_turn with tokens reported via usage.
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "looking" },
        { type: "tool_call", id: "t-1", name: "list_directory", input: { path: "src" } },
        { type: "tool_call", id: "t-2", name: "read_file", input: { path: "a" } },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 20 } },
      ],
      [
        { type: "text_delta", text: "more" },
        { type: "tool_call", id: "t-3", name: "read_file", input: { path: "b" } },
        { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 80, outputTokens: 15 } },
      ],
      [
        { type: "text_delta", text: "answer" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 10 } },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summary:
      | {
          turnDurationMs: number;
          toolCount: number;
          cumulativeToolMs: number;
          tokensIn: number;
          tokensOut: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          breakdown?: Record<string, { count: number; ms: number }>;
        }
      | null = null;

    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    expect(summary).not.toBeNull();
    expect(summary!.toolCount).toBe(3);
    // Contract (2026-05-07 v2): tokensIn = *마지막 round* 의 raw inputTokens
    // (사용자 직관 = "이번 turn 의 context size"). tokensOut + cache 는 모든
    // round 합산 (turn 의 누적 work). 사용자 보고 "10× over-count" 후 size
    // 의도로 align.
    //   round 1: in=100, out=20
    //   round 2: in= 80, out=15
    //   round 3: in= 60, out=10  (end_turn — last)
    // → tokensIn=60 (last round), tokensOut=45 (sum).
    expect(summary!.tokensIn).toBe(60);
    expect(summary!.tokensOut).toBe(45);
    expect(summary!.turnDurationMs).toBeGreaterThanOrEqual(0);
    // cumulativeToolMs aggregates per-call wall-clock — non-negative; tool
    // executor is in-process so duration may round to <1ms but never < 0.
    expect(summary!.cumulativeToolMs).toBeGreaterThanOrEqual(0);
    // Breakdown carries per-tool aggregates.
    expect(summary!.breakdown).toBeDefined();
    expect(summary!.breakdown!["read_file"].count).toBe(2);
    expect(summary!.breakdown!["list_directory"].count).toBe(1);
  });

  it("does not emit a summary for an empty/interrupted turn", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        // No text — empty assistant response.
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 0 } },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let calls = 0;
    await loop.runTurn("질문", {
      onTurnSummary: () => {
        calls += 1;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    // Turn produced no assistant text → footer suppressed (mirrors the
    // notification-gate so dropped/aborted turns don't render footers).
    expect(calls).toBe(0);
  });

  it("persists turnSummary on the final post-summary save", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "저장된 답변" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 42, outputTokens: 7 } },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: {
        saveSession,
        listSessions: () => [],
      } as never,
    });

    await loop.runTurn("질문", {}, undefined, { inputOrigin: "user-keyboard" });

    expect(saveSession).toHaveBeenCalled();
    const lastCall = saveSession.mock.calls.at(-1);
    const savedMessages = lastCall?.[1] as GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      tokensIn: 42,
      tokensOut: 7,
      freshInputTokens: 42,
    });
  });

  it("persists turnSummary on the marker-stripped post-turn transcript", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "정리 완료<title>숨김 제목</title>[checkpoint]" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 6 } },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const memoryManager = {
      saveSession,
      listSessions: () => [],
      loadSessionMetadata: () => ({}),
      saveSessionMetadata: vi.fn(async () => {}),
    };
    const settingsService = {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService,
      memoryManager,
      postTurnHookChain: new PostTurnHookChain({
        memoryManager: memoryManager as never,
        settingsService: settingsService as never,
      }),
    });

    await loop.runTurn("질문", {}, undefined, { inputOrigin: "user-keyboard" });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.content).toBe("정리 완료");
    expect(finalAssistant?.content).not.toContain("<title>");
    expect(finalAssistant?.content).not.toContain("[checkpoint]");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      tokensIn: 30,
      tokensOut: 6,
      freshInputTokens: 30,
    });
  });

  it("does not emit a turnSummary footer when the durable final save fails", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "저장 실패 답변" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 9, outputTokens: 2 } },
      ],
    ]);
    const saveSession = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const memoryManager = {
      saveSession,
      listSessions: () => [],
    };
    const settingsService = {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService,
      memoryManager,
      postTurnHookChain: new PostTurnHookChain({
        memoryManager: memoryManager as never,
        settingsService: settingsService as never,
      }),
    });
    let summaryCalls = 0;

    const result = await loop.runTurn("질문", {
      onTurnSummary: () => {
        summaryCalls += 1;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    expect(result.text).toBe("저장 실패 답변");
    expect(summaryCalls).toBe(0);
    expect(saveSession).toHaveBeenCalled();
  });

  it("persists imported trigger provenance on plugin-emitted user turns", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "처리했습니다" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 3 } },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });
    const input = '<imported-from-proactive source="overlay:daily-briefing">\n오늘 브리핑\n</imported-from-proactive>';

    await loop.runTurn(input, {}, undefined, { inputOrigin: "plugin-emitted" });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as GenericMessage[] | undefined;
    const savedUser = savedMessages?.find((message) => message.role === "user");
    expect(savedUser?.meta?.displayText).toBe("오늘 브리핑");
    expect(savedUser?.meta?.importedTrigger).toMatchObject({
      source: "overlay:daily-briefing",
      prompt: input,
      summary: "오늘 브리핑",
      toolCallCount: 0,
    });
  });

  it("persists skill routing provenance separately from visible user text", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "메일을 확인했습니다" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 12, outputTokens: 4 } },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      keywordEngine: {
        classify: () => ({ type: "skill", text: "지금 메일 읽어줘" }),
        matchAllPluginIds: () => new Set<string>(),
      } as never,
      routeEngine: { route: () => ({ route: "skill", skillId: "msgraph_email_list" }) } as never,
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });

    await loop.runTurn("지금 메일 읽어줘", {}, undefined, { inputOrigin: "user-keyboard" });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as GenericMessage[] | undefined;
    const savedUser = savedMessages?.find((message) => message.role === "user");
    expect(savedUser?.content).toBe("[스킬: msgraph_email_list] 지금 메일 읽어줘");
    expect(savedUser?.meta?.displayText).toBe("지금 메일 읽어줘");
    expect(savedUser?.meta?.routeSkill?.skillId).toBe("msgraph_email_list");
  });

  it("does not emit a summary or notification when stopReason is context-error", async () => {
    // Regression guard for Copilot round 10: context_error path must set
    // stopReason="context-error" so willEmitSummary skips, preventing stale
    // lastRoundInputTokens from being reported to the user.
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        // Emit a context-length error — triggers stream-collector context_error branch.
        // Must match isContextLengthError() patterns (see auto-compact.ts).
        { type: "error", error: "prompt is too long for this model" } as StreamEvent,
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summaryCallCount = 0;
    const result = await loop.runTurn("질문", {
      onTurnSummary: () => {
        summaryCallCount += 1;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    // stopReason must be "context-error" (not undefined / "end_turn")
    expect(result.stopReason).toBe("context-error");
    // No turn summary emitted — stale lastRoundInputTokens must not reach UI
    expect(summaryCallCount).toBe(0);
    // Error message was surfaced as turn text
    expect(result.text).toContain("한도를 초과");
  });

  it("reports zero tokens when usage is unavailable", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        // No `usage` on message_complete → result.usage stays undefined.
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry);

    let summary:
      | { tokensIn: number; tokensOut: number; toolCount: number }
      | null = null;
    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBe(0);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.toolCount).toBe(0);
  });
});
