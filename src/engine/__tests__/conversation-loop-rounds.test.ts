import { describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

describe("ConversationLoop queryLoop", () => {
  it("preserves reasoning and exposes assistant ping-pong rounds around tool execution", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
      isReadOnly: () => true,
      execute: async () => ({
        output: "src\npackage.json",
        isError: false,
      }),
    }));

    const provider = new FakeProvider([
      [
        { type: "reasoning_delta", text: "먼저 프로젝트 구조를 확인합니다." },
        { type: "text_delta", text: "구조를 먼저 살펴보겠습니다." },
        { type: "tool_call", id: "tool-1", name: "list_directory", input: { path: "src" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "reasoning_delta", text: "도구 결과를 바탕으로 답을 정리합니다." },
        { type: "text_delta", text: "구조를 확인했습니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const keywordEngine = new KeywordEngine();
    const routeEngine = new RouteEngine({ toolRegistry });

    const loop = new ConversationLoop(({
      settingsService: {
        get: () => ({ provider: "openai", model: "gpt-4o" }),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      keywordEngine,
      routeEngine,
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const reasoningDeltas: string[] = [];
    const rounds: Array<{ text: string; thought: string; stopReason: "end_turn" | "tool_use"; hasToolCalls: boolean }> = [];
    const toolEvents: Array<{ type: "start" | "end"; name: string }> = [];

    const result = await loop.runTurn("질문", {
      onReasoningDelta: (text) => reasoningDeltas.push(text),
      onAssistantRound: ({ text, thought, stopReason, hasToolCalls }) => {
        rounds.push({ text, thought, stopReason, hasToolCalls });
      },
      onToolStart: (name) => toolEvents.push({ type: "start", name }),
      onToolEnd: (name) => toolEvents.push({ type: "end", name }),
    });

    expect(result).toMatchObject({
      text: "구조를 확인했습니다.",
      toolCalls: [{
        name: "list_directory",
        input: { path: "src" },
        result: "src\npackage.json",
      }],
    });
    expect(reasoningDeltas).toEqual([
      "먼저 프로젝트 구조를 확인합니다.",
      "도구 결과를 바탕으로 답을 정리합니다.",
    ]);
    expect(rounds).toEqual([
      {
        text: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        stopReason: "tool_use",
        hasToolCalls: true,
      },
      {
        text: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
        stopReason: "end_turn",
        hasToolCalls: false,
      },
    ]);
    expect(toolEvents).toEqual([
      { type: "start", name: "list_directory" },
      { type: "end", name: "list_directory" },
    ]);
    expect(loop.getHistory().getMessages()).toEqual([
      { role: "user", content: "질문" },
      {
        role: "assistant",
        content: "구조를 먼저 살펴보겠습니다.",
        thought: "먼저 프로젝트 구조를 확인합니다.",
        toolCalls: [{ id: "tool-1", name: "list_directory", input: { path: "src" } }],
      },
      {
        role: "tool_result",
        toolUseId: "tool-1",
        toolName: "list_directory",
        content: "src\npackage.json",
      },
      {
        role: "assistant",
        content: "구조를 확인했습니다.",
        thought: "도구 결과를 바탕으로 답을 정리합니다.",
      },
    ]);
  });
});
