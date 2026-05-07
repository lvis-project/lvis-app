import { describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function createLoopWithRegistry(provider: FakeProvider, toolRegistry: ToolRegistry): ConversationLoop {
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
    });

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
    });

    // Turn produced no assistant text → footer suppressed (mirrors the
    // notification-gate so dropped/aborted turns don't render footers).
    expect(calls).toBe(0);
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
    });

    expect(summary).not.toBeNull();
    expect(summary!.tokensIn).toBe(0);
    expect(summary!.tokensOut).toBe(0);
    expect(summary!.toolCount).toBe(0);
  });
});
