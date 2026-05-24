/**
 * Phase 1.5 Option C — request_plugin meta-tool integration.
 *
 * Verifies:
 *   1. Calling request_plugin activates the plugin and exposes its tool
 *      schemas in the next streaming round.
 *   2. Unknown pluginId returns an error tool_result without mutating scope.
 *   3. MAX_PLUGIN_EXPANSION (=2) is enforced per turn.
 */
import { describe, it, expect } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnInput } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnInput): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(opts: {
  provider: LLMProvider;
  availablePluginIds: string[];
  allowedPluginIds?: string[];
  forcedActivePluginIds?: string[];
  forcedActiveToolNames?: string[];
}): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  // request_plugin builtin (source=builtin so scope filter includes it)
  toolRegistry.register(createDynamicTool({
    name: "request_plugin",
    description: "활성화 요청",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["pluginId"],
      properties: { pluginId: { type: "string" } },
    },
    execute: async () => ({ output: "unreachable", isError: false }),
  }));
  toolRegistry.register(createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: "도구 검색",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    execute: async () => ({ output: "unreachable", isError: false }),
  }));
  // a plugin tool gated by com.example.meeting scope
  toolRegistry.register(createDynamicTool({
    name: "meeting_start",
    description: "회의 시작",
    source: "plugin",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "started", isError: false }),
  }));

  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });

  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: {
      build: () => "system",
      setToolScope: () => {},
    },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => [],
    },
    pluginRuntime: {
      listPluginIds: () => opts.availablePluginIds,
    },
    ...(opts.allowedPluginIds ? { allowedPluginIds: new Set(opts.allowedPluginIds) } : {}),
    ...(opts.forcedActivePluginIds ? { forcedActivePluginIds: new Set(opts.forcedActivePluginIds) } : {}),
    ...(opts.forcedActiveToolNames ? { forcedActiveToolNames: new Set(opts.forcedActiveToolNames) } : {}),
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = opts.provider;
  return loop;
}

describe("ConversationLoop — request_plugin meta tool (Option C)", () => {
  it("activates plugin catalog without exposing all plugin schemas", async () => {
    const provider = new RecordingProvider([
      // Round 0: LLM asks to activate meeting plugin.
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "com.example.meeting" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "카탈로그 활성화" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["com.example.meeting"] });
    const result = await loop.runTurn("일반 질문", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("카탈로그 활성화");
    // Round 0 should NOT have meeting_start available.
    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    // Round 1 keeps plugin tools deferred; tool_search remains the discovery path.
    expect(provider.observedToolNames[1]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[1]).not.toContain("meeting_start");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as { content: string } | undefined;
    expect(toolResult?.content).toContain("카탈로그");
    expect(toolResult?.content).not.toContain("0개 도구 추가됨");
  });

  it("supports request_plugin -> tool_search in the same assistant round", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "com.example.meeting" } },
        { type: "tool_call", id: "tu-2", name: TOOL_SEARCH_TOOL_NAME, input: { query: "meeting_start" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-3", name: "meeting_start", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "회의를 시작했습니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["com.example.meeting"] });
    const result = await loop.runTurn("일반 질문", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("회의를 시작했습니다.");
    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    expect(provider.observedToolNames[1]).toContain("meeting_start");
  });

  it("returns error tool_result for unknown pluginId", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "nope.nope" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "미등록 플러그인입니다." },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["com.example.meeting"] });
    const result = await loop.runTurn("아무거나", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("미등록 플러그인입니다.");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as { content: string; isError?: boolean } | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 플러그인 ID");
  });

  it("enforces MAX_PLUGIN_EXPANSION (=2) per turn", async () => {
    // Ensure 3 available plugins; third activation must be rejected.
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "p1" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-2", name: "request_plugin", input: { pluginId: "p2" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-3", name: "request_plugin", input: { pluginId: "p3" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, availablePluginIds: ["p1", "p2", "p3"] });
    await loop.runTurn("trigger", undefined, undefined, { inputOrigin: "user-keyboard" });
    const messages = loop.getHistory().getMessages();
    const toolResults = messages.filter((m) => m.role === "tool_result") as Array<{ content: string; isError?: boolean }>;
    expect(toolResults.length).toBe(3);
    expect(toolResults[0].isError).not.toBe(true);
    expect(toolResults[1].isError).not.toBe(true);
    expect(toolResults[2].isError).toBe(true);
    expect(toolResults[2].content).toContain("한도 초과");
  });

  it("rejects request_plugin outside the loop allowedPluginIds scope", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "request_plugin", input: { pluginId: "com.example.meeting" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "blocked" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      allowedPluginIds: [],
    });

    await loop.runTurn("일반 질문", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    const messages = loop.getHistory().getMessages();
    const toolResult = messages.find((m) => m.role === "tool_result") as { content: string; isError?: boolean } | undefined;
    expect(toolResult?.isError).toBe(true);
    expect(toolResult?.content).toContain("알 수 없는 플러그인 ID");
  });

  it("keeps explicitly allowlisted tools visible even when allowedPluginIds is deny-all", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      availablePluginIds: ["com.example.meeting"],
      allowedPluginIds: [],
      forcedActivePluginIds: ["com.example.meeting"],
      forcedActiveToolNames: ["meeting_start"],
    });

    await loop.runTurn("일반 질문", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[0]).toContain("meeting_start");
  });
});
