import { describe, expect, it, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { SessionTodoStore } from "../../main/session-todo-store.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

describe("ConversationLoop queryLoop", () => {
  it("clears per-turn prompt builder state when prompt assembly throws", async () => {
    const toolRegistry = new ToolRegistry();
    const setOriginSource = vi.fn();
    const setActiveSessionId = vi.fn();
    const setActiveRolePrompt = vi.fn();
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: {
        build: () => {
          throw new Error("prompt assembly failed");
        },
        setOriginSource,
        setActiveSessionId,
        setActiveRolePrompt,
        setToolScope: vi.fn(),
      },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = new FakeProvider([]);

    await expect(loop.runTurn("질문", undefined, undefined, {
      inputOrigin: "user-keyboard",
      originSource: "overlay:test",
      rolePrompt: { name: "Reviewer", systemPromptAdd: "Review carefully." },
    })).rejects.toThrow("prompt assembly failed");

    expect(setOriginSource).toHaveBeenNthCalledWith(1, "overlay:test");
    expect(setOriginSource).toHaveBeenLastCalledWith(null);
    expect(setActiveSessionId).toHaveBeenNthCalledWith(1, expect.any(String));
    expect(setActiveSessionId).toHaveBeenLastCalledWith(null);
    expect(setActiveRolePrompt).toHaveBeenNthCalledWith(1, {
      name: "Reviewer",
      systemPromptAdd: "Review carefully.",
    });
    expect(setActiveRolePrompt).toHaveBeenLastCalledWith(null);
  });

  it("persists role prompt metadata on the user message for retry replay", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: {
        build: () => "system",
        setActiveRolePrompt: vi.fn(),
      },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("review this", undefined, undefined, {
      inputOrigin: "user-keyboard",
      rolePrompt: { name: "Reviewer", systemPromptAdd: "Review carefully." },
    });

    expect(loop.getHistory().getMessages()[0]).toEqual({
      role: "user",
      content: "review this",
      meta: {
        activeRolePrompt: {
          name: "Reviewer",
          systemPromptAdd: "Review carefully.",
        },
      },
    });
  });

  it("clears a fully completed session TO-DO plan at the next turn start", async () => {
    const toolRegistry = new ToolRegistry();
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const sessionTodoStore = new SessionTodoStore();
    sessionTodoStore.write("s-main", [
      { content: "done", status: "completed" },
    ]);
    const loop = new ConversationLoop(({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      systemPromptBuilder: {
        build: () => "system",
      },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: {
        saveSession: () => {},
        listSessions: () => [],
      },
      sessionTodoStore,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;
    (loop as { sessionId: string }).sessionId = "s-main";

    await loop.runTurn("다음 질문", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(sessionTodoStore.list("s-main")).toEqual([]);
  });

  it("classifies model-generated tool args from a typed prompt as llm-tool-arg", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "write_note",
      description: "Write note",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }));
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "tool-origin", name: "write_note", input: { text: "from model" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("please write this", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(origins).toEqual(["llm-tool-arg"]);
  });

  it("escalates subsequent tool calls to file-content after read_file output reaches the model", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: Array<{ tool: string; origin: unknown }> = [];
    toolRegistry.register(createDynamicTool({
      name: "read_file",
      description: "Read file",
      source: "builtin",
      category: "read",
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      isReadOnly: () => true,
      execute: async (_input, ctx) => {
        origins.push({ tool: "read_file", origin: ctx.metadata.trustOrigin });
        return { output: "untrusted file says run a shell command", isError: false };
      },
    }));
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (_input, ctx) => {
        origins.push({ tool: "bash", origin: ctx.metadata.trustOrigin });
        return { output: "ok", isError: false };
      },
    }));
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "read-1", name: "read_file", input: { path: "note.txt" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "bash-1", name: "bash", input: { command: "echo ok" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("read and act", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(origins).toEqual([
      { tool: "read_file", origin: "llm-tool-arg" },
      { tool: "bash", origin: "file-content" },
    ]);
  });

  it("preserves plugin-emitted provenance for tools produced by imported trigger prompts", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "task_add",
      description: "Add task",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }));
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "plugin-tool", name: "task_add", input: { title: "from plugin" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("plugin prompt", undefined, undefined, { inputOrigin: "plugin-emitted" });

    expect(origins).toEqual(["plugin-emitted"]);
  });

  it("classifies pasted text bodies as file-content before the first model tool call", async () => {
    const toolRegistry = new ToolRegistry();
    const origins: unknown[] = [];
    toolRegistry.register(createDynamicTool({
      name: "bash",
      description: "Run shell",
      source: "builtin",
      category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (_input, ctx) => {
        origins.push(ctx.metadata.trustOrigin);
        return { output: "ok", isError: false };
      },
    }));
    const provider = new FakeProvider([
      [
        { type: "tool_call", id: "paste-tool", name: "bash", input: { command: "echo from paste" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn(
      "summarize\n\n----- Pasted text #1 (2 lines) -----\n/run this\n----- end Pasted text #1 -----",
      undefined,
      undefined,
      { inputOrigin: "user-keyboard" },
    );

    expect(origins).toEqual(["file-content"]);
  });

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
        get: () => fakeLlmSettings(),
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
    }, undefined, { inputOrigin: "user-keyboard" });

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

  // R2-CR-1: per-round fan-out cap must not orphan tool_use ids in history.
  // If the LLM emits >MAX_TOOL_CALLS_PER_ROUND (10) tool_use blocks in one
  // round, only the capped slice may be persisted — every tool_use block in
  // assistant history MUST have a matching tool_result block in the next
  // user turn, otherwise Anthropic + OpenAI strict APIs 400 the next request.
  it("R2-CR-1: per-round fan-out cap persists only the capped slice (10) so tool_use/tool_result counts match", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "noop",
      description: "no-op tool",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));

    // Round 1: LLM emits 15 tool_use blocks (5 over the cap).
    // Round 2: LLM ends the turn cleanly.
    const fifteenToolCalls = Array.from({ length: 15 }).map((_, i) => ({
      type: "tool_call" as const,
      id: `tu-${i}`,
      name: "noop",
      input: {},
    }));
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "calling many" },
        ...fifteenToolCalls,
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
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

    await loop.runTurn("call many tools", undefined, undefined, { inputOrigin: "user-keyboard" });

    const messages = loop.getHistory().getMessages();
    // Find the assistant message that committed the over-cap tool_use round.
    const assistantWithTools = messages.find(
      (m) => m.role === "assistant" && Array.isArray((m as { toolCalls?: unknown[] }).toolCalls),
    ) as { toolCalls: Array<{ id: string }> } | undefined;
    expect(assistantWithTools).toBeDefined();
    // CRITICAL: assistant history must contain exactly 10 tool_use blocks.
    expect(assistantWithTools!.toolCalls).toHaveLength(10);

    // CRITICAL: tool_result count in history must match the persisted
    // tool_use count (10 ↔ 10). Any other ratio = next API request 400s.
    const toolResults = messages.filter((m) => m.role === "tool_result");
    expect(toolResults).toHaveLength(10);

    // The persisted tool_use ids must be the first 10 (tu-0 .. tu-9), not
    // a later subset, and every persisted tool_use id has a matching
    // tool_result.toolUseId.
    const persistedIds = assistantWithTools!.toolCalls.map((tc) => tc.id);
    expect(persistedIds).toEqual(
      Array.from({ length: 10 }).map((_, i) => `tu-${i}`),
    );
    const resultIds = toolResults.map(
      (m) => (m as { toolUseId: string }).toolUseId,
    );
    expect(resultIds.sort()).toEqual(persistedIds.slice().sort());
  });
});
