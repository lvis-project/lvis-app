import { afterEach, describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, ToolSchema } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { PostTurnHookChain } from "../../hooks/post-turn-hook-chain.js";
import { FallbackProvider } from "../llm/vercel/fallback-chain.js";
import { estimateRequestInputProjection } from "../request-input-projection.js";

afterEach(() => {
  vi.useRealTimers();
});

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function createLoopWithRegistry(
  provider: LLMProvider,
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

function visibleToolSchemas(toolRegistry: ToolRegistry): ToolSchema[] {
  return toolRegistry.getToolSchemasForScope({
    activePluginIds: new Set<string>(),
    includeBuiltins: true,
    includeMcp: false,
  }).map((schema) => ({
    name: schema.name,
    description: schema.description,
    inputSchema: schema.input_schema as ToolSchema["inputSchema"],
  }));
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
    // Contract (Issue #912): tokensIn = turn-end projected context input.
    // It is the same SOT that TokenProgressRing consumes, not the last
    // provider round alone. tokensOut + cache remain turn-aggregate work.
    //   round 1: in=100, out=20
    //   round 2: in= 80, out=15
    //   round 3: in= 60, out=10  (end_turn — last)
    // → tokensIn > 60 because final assistant output is now part of the next
    // request context; tokensOut=45 (sum).
    expect(summary!.tokensIn).toBeGreaterThan(60);
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
      tokensIn: expect.any(Number),
      tokensOut: 7,
      freshInputTokens: 42,
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(finalAssistant?.meta?.turnSummary?.tokensIn ?? 0).toBeGreaterThan(42);
  });

  it("attributes fallback-served turns to the provider/model that actually streamed", async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    const primary: LLMProvider = {
      vendor: "claude",
      streamTurn: async function* () {
        yield { type: "error", error: "500 internal server error", classification: "network" };
      },
    };
    const fallback = new FakeProvider([
      [
        { type: "text_delta", text: "fallback answer" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 2 } },
      ],
    ]);
    const provider = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-5.4-mini" }],
      () => "test-key",
      undefined,
      () => fallback,
    );
    const saveSession = vi.fn(async () => {});
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService: {
        get: () => fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
        getSecret: () => "test-key",
      },
      memoryManager: { saveSession, listSessions: () => [] } as never,
      auditLogger: auditLogger as never,
    });

    let summary:
      | { vendorProvider?: string; vendorModel?: string }
      | null = null;
    const pending = loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    vi.useRealTimers();

    expect(summary).toMatchObject({
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as GenericMessage[] | undefined;
    const finalAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");
    expect(finalAssistant?.meta?.turnSummary).toMatchObject({
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(auditLogger.logTurn).toHaveBeenCalledWith(
      expect.objectContaining({ route: "openai/gpt-5.4-mini" }),
    );
  });

  it("keeps mixed-provider fallback rounds out of single-model turn badge pricing", async () => {
    vi.useFakeTimers();
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async () => ({ output: "contents", isError: false }),
    }));
    let primaryCalls = 0;
    const primary: LLMProvider = {
      vendor: "claude",
      streamTurn: async function* () {
        primaryCalls += 1;
        if (primaryCalls === 1) {
          yield { type: "tool_call", id: "t-1", name: "read_file", input: { path: "a" } };
          yield { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 100, outputTokens: 10 } };
          return;
        }
        yield { type: "error", error: "500 internal server error", classification: "network" };
      },
    };
    const fallback = new FakeProvider([
      [
        { type: "text_delta", text: "fallback final" },
        { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5 } },
      ],
    ]);
    const provider = new FallbackProvider(
      primary,
      [{ provider: "openai", model: "gpt-5.4-mini" }],
      () => "test-key",
      undefined,
      () => fallback,
    );
    const saveSession = vi.fn(async () => {});
    const auditLogger = {
      logTurn: vi.fn(),
      logToolCall: vi.fn(),
      isPermissionAuditChainReady: () => false,
    };
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      settingsService: {
        get: () => fakeLlmSettings({ provider: "claude", model: "claude-sonnet-4-6" }),
        getSecret: () => "test-key",
      },
      memoryManager: { saveSession, listSessions: () => [] } as never,
      auditLogger: auditLogger as never,
    });

    let summary:
      | { vendorProvider?: string; vendorModel?: string }
      | null = null;
    const pending = loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    vi.useRealTimers();

    expect(summary?.vendorProvider).toBeUndefined();
    expect(summary?.vendorModel).toBeUndefined();
    expect(auditLogger.logTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        usageByModel: [
          expect.objectContaining({ vendorProvider: "claude", vendorModel: "claude-sonnet-4-6" }),
          expect.objectContaining({ vendorProvider: "openai", vendorModel: "gpt-5.4-mini" }),
        ],
      }),
    );
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
      tokensIn: expect.any(Number),
      tokensOut: 6,
      freshInputTokens: 30,
      vendorProvider: "openai",
      vendorModel: "gpt-5.4-mini",
    });
    expect(finalAssistant?.meta?.turnSummary?.tokensIn ?? 0).toBeGreaterThan(30);
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
    // lastRoundProviderInputTokens from being reported to the user.
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
    // No turn summary emitted — stale lastRoundProviderInputTokens must not reach UI
    expect(summaryCallCount).toBe(0);
    // Error message was surfaced as turn text
    expect(result.text).toContain("한도를 초과");
  });

  it("reports estimated context tokens when provider usage is unavailable", async () => {
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
    expect(summary!.tokensIn).toBeGreaterThan(0);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.toolCount).toBe(0);
  });

  it("uses engine request projection when provider usage is unavailable", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "large_schema_tool",
      description: "Tool with intentionally large schema description ".repeat(200),
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "query text ".repeat(200) },
        },
        required: ["query"],
      },
      isReadOnly: () => true,
      execute: async () => ({ output: "ok", isError: false }),
    }));
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      systemPromptBuilder: {
        build: () => "system prompt overhead ".repeat(300),
        setToolScope: vi.fn(),
        setOriginSource: vi.fn(),
        setActiveSessionId: vi.fn(),
        setActiveRolePrompt: vi.fn(),
      } as never,
    });

    let summary:
      | { tokensIn: number; tokensOut: number; toolCount: number }
      | null = null;
    await loop.runTurn("질문", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBeGreaterThan(3_000);
    expect(summary!.tokensOut).toBe(0);
  });

  it("derives post-tool turnSummary.tokensIn from engine projection when tool results carry over", async () => {
    const largeToolResult = "large search result payload ".repeat(250);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "large_search",
      description: "Return a large search result",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      isReadOnly: () => true,
      execute: async () => ({ output: largeToolResult, isError: false }),
    }));
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "searching" },
        { type: "tool_call", id: "large-1", name: "large_search", input: { query: "budget" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "large result summarized" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const saveSession = vi.fn(async () => {});
    const loop = createLoopWithRegistry(provider, toolRegistry, {
      memoryManager: { saveSession, listSessions: () => [] } as never,
    });

    let summary:
      | { tokensIn: number; tokensOut: number; freshInputTokens: number }
      | null = null;
    await loop.runTurn("큰 검색 결과를 요약해줘", {
      onTurnSummary: (s) => {
        summary = s;
      },
    }, undefined, { inputOrigin: "user-keyboard" });

    const savedMessages = saveSession.mock.calls.at(-1)?.[1] as GenericMessage[] | undefined;
    expect(savedMessages).toBeDefined();
    const toolResult = savedMessages?.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toBe(largeToolResult);
    expect(toolResult?.meta?.truncated).toBeUndefined();
    const expectedProjection = estimateRequestInputProjection({
      systemPrompt: "system",
      messages: savedMessages ?? [],
      toolSchemas: visibleToolSchemas(toolRegistry),
    });
    const savedAssistant = savedMessages?.slice().reverse().find((message) => message.role === "assistant");

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBe(expectedProjection.totalTokens);
    expect(summary!.tokensIn).toBeGreaterThan(1_000);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.freshInputTokens).toBe(0);
    expect(savedAssistant?.meta?.turnSummary?.tokensIn).toBe(expectedProjection.totalTokens);
  });
});
