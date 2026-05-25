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
import { describe, it, expect, vi } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { TOOL_SEARCH_TOOL_NAME } from "../../tools/registry.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

type CapturedToolExposure = {
  loadedToolCount: number;
  deferredCatalogCount: number;
  deferralEligibleLoadedCount: number;
  deferredLoadedRatio: number | null;
};

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
  headless?: boolean;
  auditLogger?: AuditLogger;
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
  toolRegistry.register(createDynamicTool({
    name: "msgraph_email_list",
    description: "Microsoft Graph 메일 목록",
    source: "plugin",
    category: "read",
    pluginId: "com.example.msgraph",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "msgraph emails", isError: false }),
  }));
  toolRegistry.register(createDynamicTool({
    name: "mcp_fetch",
    description: "MCP fetch",
    source: "mcp",
    category: "read",
    mcpServerId: "browser",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "mcp", isError: false }),
  }));

  const keywordEngine = new KeywordEngine();
  // "회의" keyword → plugin scope (meeting) AND tool preload (meeting_start).
  keywordEngine.registerKeywords([
    { keyword: "회의", skillId: "meeting_start", pluginId: "com.example.meeting" },
    { keyword: "메일", skillId: "email_list", pluginId: "com.example.email" },
    { keyword: "msgraph", skillId: "msgraph_email_list", pluginId: "com.example.msgraph" },
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
      listPluginIds: () => ["com.example.meeting", "com.example.email", "com.example.msgraph"],
    },
    headless: opts.headless,
    ...(opts.auditLogger ? { auditLogger: opts.auditLogger } : {}),
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

  it("drops carried plugin tools when the next turn asks for builtin tool inventory", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "meeting scoped" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "builtin list" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });

    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("빌트인 툴 리스트 보여줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[1]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[1]).not.toContain("meeting_start");
    expect(provider.observedToolNames[1]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[1]).not.toContain("msgraph_email_list");
  });

  it("drops carried msgraph plugin tools when the next turn asks for builtin tool inventory", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "msgraph scoped" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "builtin list" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });

    await loop.runTurn("msgraph 이메일 확인해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("기본 내장 도구만 보여줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[0]).toContain("msgraph_email_list");
    expect(provider.observedToolNames[1]).toContain(TOOL_SEARCH_TOOL_NAME);
    expect(provider.observedToolNames[1]).not.toContain("msgraph_email_list");
    expect(provider.observedToolNames[1]).not.toContain("meeting_start");
  });

  it("does not carry unused tool_search promotions into the following turn", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: TOOL_SEARCH_TOOL_NAME, input: { query: "meeting_stop" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "loaded but unused" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "follow-up" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });

    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("계속 진행해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(provider.observedToolNames[1]).toContain("meeting_stop");
    expect(provider.observedToolNames[2]).toContain("meeting_start");
    expect(provider.observedToolNames[2]).not.toContain("meeting_stop");
  });

  it("keeps MCP tools out of headless deferral catalog and loaded schemas", async () => {
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: TOOL_SEARCH_TOOL_NAME, input: { query: "mcp_fetch" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "no mcp" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, headless: true });

    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(result.text).toBe("no mcp");
    expect(provider.observedToolNames[0]).not.toContain("mcp_fetch");
    expect(provider.observedToolNames[1]).not.toContain("mcp_fetch");
    const toolResult = loop.getHistory().getMessages().find((m) => m.role === "tool_result");
    expect(toolResult?.content).toContain("'mcp_fetch' 에 매치되는 미로드 도구 없음");
    expect(toolResult?.isError).toBe(true);
  });

  it("emits the deferred/loaded ratio metric with correct counts", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const auditLogger = new AuditLogger();
    const captured: CapturedToolExposure[] = [];
    vi.spyOn(auditLogger, "logTurn").mockImplementation(
      (params: { toolExposure?: CapturedToolExposure }) => {
        if (params.toolExposure) captured.push(params.toolExposure);
      },
    );
    const loop = makeLoop({ provider, auditLogger });

    // "회의" keyword loads meeting_start (plugin) + tool_search (builtin). The
    // deferral-eligible universe for a main turn is meeting_stop (plugin, in
    // the meeting scope) plus mcp_fetch (MCP is in scope for main sessions) —
    // both stay deferred. email/msgraph plugins are not active this turn.
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(captured).toHaveLength(1);
    const exposure = captured[0];
    // Loaded: tool_search (builtin) + meeting_start (plugin).
    expect(exposure.loadedToolCount).toBe(2);
    // Only the plugin slice is deferral-eligible — builtins never count.
    expect(exposure.deferralEligibleLoadedCount).toBe(1);
    // Deferred: meeting_stop (plugin) + mcp_fetch (MCP) stay in the catalog.
    expect(exposure.deferredCatalogCount).toBe(2);
    // ratio = deferred / (deferred + deferral-eligible loaded) = 2 / (2 + 1).
    expect(exposure.deferredLoadedRatio).toBeCloseTo(2 / 3, 10);
  });

  it("reports a null deferred/loaded ratio when no deferral-eligible tool exists", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "builtin only" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const auditLogger = new AuditLogger();
    const captured: CapturedToolExposure[] = [];
    vi.spyOn(auditLogger, "logTurn").mockImplementation(
      (params: { toolExposure?: CapturedToolExposure }) => {
        if (params.toolExposure) captured.push(params.toolExposure);
      },
    );
    // Headless excludes MCP, and a keyword-miss builtin-inventory prompt
    // activates no plugin scope — so the deferral-eligible universe is empty
    // and the ratio is undefined (null), not 0.
    const loop = makeLoop({ provider, auditLogger, headless: true });

    await loop.runTurn("빌트인 툴 리스트 보여줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(captured).toHaveLength(1);
    const exposure = captured[0];
    expect(exposure.deferralEligibleLoadedCount).toBe(0);
    expect(exposure.deferredCatalogCount).toBe(0);
    expect(exposure.deferredLoadedRatio).toBeNull();
  });
});
