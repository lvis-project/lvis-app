/**
 * Tool-Level Deferral — ConversationLoop integration.
 *
 * Mirrors request-plugin.test's RecordingProvider harness.
 *
 * Verifies:
 *   1. turn-1 tools[] = builtins + keyword-preloaded only (deferred plugin
 *      tools absent); after tool_search, the next round includes the promoted
 *      tool.
 *   2. persisted flag false does not revive the removed whole-plugin path.
 */
import { describe, it, expect } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly observedToolNames: string[][] = [];

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function makeLoop(opts: {
  provider: LLMProvider;
  toolDeferral?: boolean;
}): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  // tool_search builtin (statically registered; visible with builtins).
  toolRegistry.register(createDynamicTool({
    name: TOOL_SEARCH_TOOL_NAME,
    description: "도구 검색",
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
    execute: async () => ({ output: "unreachable", isError: false }),
  }));
  // two meeting tools — same plugin, so the legacy path loads BOTH while the
  // deferral path loads only the keyword-preloaded one until tool_search.
  toolRegistry.register(createDynamicTool({
    name: "meeting_start",
    description: "회의 시작",
    source: "plugin",
    category: "read",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "started", isError: false }),
  }));
  toolRegistry.register(createDynamicTool({
    name: "meeting_stop",
    description: "회의 종료",
    source: "plugin",
    category: "write",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "stopped", isError: false }),
  }));
  toolRegistry.register(createDynamicTool({
    name: "email_list",
    description: "메일 목록",
    source: "plugin",
    category: "read",
    pluginId: "com.example.email",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "emails", isError: false }),
  }));

  const keywordEngine = new KeywordEngine();
  // "회의" keyword → plugin scope (meeting) AND tool preload (meeting_start).
  keywordEngine.registerKeywords([
    { keyword: "회의", skillId: "meeting_start", pluginId: "com.example.meeting" },
    { keyword: "메일", skillId: "email_list", pluginId: "com.example.email" },
  ]);
  const routeEngine = new RouteEngine({ toolRegistry });

  const loop = new ConversationLoop(({
    settingsService: {
      get: (key: string) => (key === "experimental"
        ? { toolDeferral: opts.toolDeferral }
        : fakeLlmSettings()),
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
      listPluginIds: () => ["com.example.meeting"],
    },
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = opts.provider;
  return loop;
}

describe("ConversationLoop — Tool-Level Deferral", () => {
  it("preloads keyword tool, defers the rest, promotes via tool_search", async () => {
    const provider = new RecordingProvider([
      // Round 0: model loads the deferred meeting_stop via tool_search.
      [
        { type: "tool_call", id: "tu-1", name: TOOL_SEARCH_TOOL_NAME, input: { query: "meeting_stop" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      // Round 1: model now calls meeting_stop (should be available).
      [
        { type: "tool_call", id: "tu-2", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      // Round 2: wrap up.
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("완료");

    // Round 0: tool_search visible; meeting_start preloaded (keyword); meeting_stop deferred.
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    // Round 1: meeting_stop now loaded after tool_search promotion.
    expect(provider.observedToolNames[1]).toContain("meeting_stop");
  });

  it("persisted flag false still defers plugin tools and exposes tool_search", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, toolDeferral: false });
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    // Active plugin scope alone no longer loads every plugin tool.
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it("clamps carried-forward tools when plugin scope changes", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: TOOL_SEARCH_TOOL_NAME, input: { query: "meeting_stop" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "meeting done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "email done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("메일 확인해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[1]).toContain("meeting_stop");
    expect(provider.observedToolNames[2]).toContain("email_list");
    expect(provider.observedToolNames[2]).not.toContain("meeting_start");
    expect(provider.observedToolNames[2]).not.toContain("meeting_stop");
  });
});
