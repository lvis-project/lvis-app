/**
 * Tool-Exposure / Deferral gate — ConversationLoop integration (#1176).
 *
 * Mirrors request-plugin.test's RecordingProvider harness.
 *
 * Verifies the post-#1176 semantics:
 *   1. Below EAGER_TOOL_EXPOSURE_CEILING (the common case), an active plugin's
 *      whole tool suite is exposed eagerly — no `tool_search` discovery, empty
 *      catalog, deferred/loaded ratio 0.
 *   2. Active/inactive (enabled) gating drops a disabled plugin's tools from
 *      both the loaded schemas and the catalog.
 *   3. At/above the ceiling the turn falls back to per-tool deferral, and
 *      builtins are never counted toward the ceiling.
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
import { EAGER_TOOL_EXPOSURE_CEILING } from "../../shared/tool-exposure-policy.js";
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

function readonlyPluginTool(name: string, pluginId: string) {
  return createDynamicTool({
    name,
    description: `${name} desc`,
    source: "plugin" as const,
    category: "read" as const,
    pluginId,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  });
}

function makeLoop(opts: {
  provider: LLMProvider;
  headless?: boolean;
  auditLogger?: AuditLogger;
  /** Plugin ids reported inactive by the runtime mock (enabled === false). */
  inactivePluginIds?: Set<string>;
  /** Extra synthetic plugin tools to register (e.g. to cross the ceiling). */
  extraMeetingTools?: number;
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
  toolRegistry.register(readonlyPluginTool("meeting_start", "com.example.meeting"));
  toolRegistry.register(readonlyPluginTool("meeting_stop", "com.example.meeting"));
  toolRegistry.register(readonlyPluginTool("email_list", "com.example.email"));
  toolRegistry.register(readonlyPluginTool("msgraph_email_list", "com.example.msgraph"));
  toolRegistry.register(createDynamicTool({
    name: "mcp_fetch",
    description: "MCP fetch",
    source: "mcp",
    category: "read",
    mcpServerId: "browser",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "mcp", isError: false }),
  }));
  // Synthetic extra meeting tools — used by the ceiling test to push the
  // eligible count past EAGER_TOOL_EXPOSURE_CEILING.
  for (let i = 0; i < (opts.extraMeetingTools ?? 0); i += 1) {
    toolRegistry.register(readonlyPluginTool(`meeting_extra_${i}`, "com.example.meeting"));
  }

  const keywordEngine = new KeywordEngine();
  // "회의" keyword → plugin scope (meeting) AND tool preload (meeting_start).
  keywordEngine.registerKeywords([
    { keyword: "회의", skillId: "meeting_start", pluginId: "com.example.meeting" },
    { keyword: "메일", skillId: "email_list", pluginId: "com.example.email" },
    { keyword: "msgraph", skillId: "msgraph_email_list", pluginId: "com.example.msgraph" },
  ]);
  const routeEngine = new RouteEngine({ toolRegistry });
  const inactive = opts.inactivePluginIds ?? new Set<string>();

  const loop = new ConversationLoop(({
    settingsService: {
      get: (key: string) => (key === "experimental" ? {} : fakeLlmSettings()),
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
      isPluginEnabled: (pluginId: string) => !inactive.has(pluginId),
    },
    headless: opts.headless,
    ...(opts.auditLogger ? { auditLogger: opts.auditLogger } : {}),
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = opts.provider;
  return loop;
}

describe("ConversationLoop — eager active-plugin tool exposure (#1176)", () => {
  it("exposes the active plugin's whole suite eagerly with zero tool_search (indexer-like)", async () => {
    const provider = new RecordingProvider([
      // The model can call meeting_stop directly — it is already loaded, so it
      // must NOT need a tool_search round to discover it.
      [
        { type: "tool_call", id: "tu-1", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("완료");

    // Round 0: the full meeting suite is loaded up front (both tools), so the
    // model never has to call tool_search.
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
    // Other plugins are out of scope and stay absent.
    expect(provider.observedToolNames[0]).not.toContain("email_list");
    // Zero tool_search calls were issued across the turn.
    const searchCalls = loop
      .getHistory()
      .getMessages()
      .filter((m) => m.role === "tool_result" && m.toolName === TOOL_SEARCH_TOOL_NAME);
    expect(searchCalls).toHaveLength(0);
  });

  it("emits an empty catalog and a 0 deferred ratio in eager mode", async () => {
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
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(captured).toHaveLength(1);
    const exposure = captured[0];
    // Loaded eligible in eager mode: meeting_start + meeting_stop (plugin) AND
    // mcp_fetch (MCP is in scope for a non-headless main turn and loads eagerly
    // too). Builtins (tool_search) are loaded but never counted.
    expect(exposure.deferralEligibleLoadedCount).toBe(3);
    // Nothing deferred — the catalog is empty in eager mode.
    expect(exposure.deferredCatalogCount).toBe(0);
    // ratio = deferred / (deferred + eligible-loaded) = 0 / 3 = 0.
    expect(exposure.deferredLoadedRatio).toBe(0);
  });
});

describe("ConversationLoop — active/inactive plugin gating (#1176)", () => {
  it("hides a disabled plugin's tools from both schema and catalog", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({
      provider,
      inactivePluginIds: new Set(["com.example.meeting"]),
    });
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    // The meeting plugin is inactive → its tools are absent from the loaded
    // schema entirely (they are not deferred to a catalog — they are gone).
    expect(provider.observedToolNames[0]).not.toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    // tool_search (builtin) is still present — builtins are unaffected.
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
  });

  it("re-exposes the suite once the plugin is active again", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider }); // active
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
  });

  it("onPluginDisabled prunes the disabled plugin from carried-forward scope", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "meeting scoped" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
      [
        { type: "text_delta", text: "after disable" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider });
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(provider.observedToolNames[0]).toContain("meeting_start");

    // Simulate the disable hook firing — the carried-forward meeting scope is
    // pruned so a follow-up non-keyword turn no longer revives meeting tools.
    loop.onPluginDisabled("com.example.meeting");
    await loop.runTurn("계속 진행해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(provider.observedToolNames[1]).not.toContain("meeting_start");
    expect(provider.observedToolNames[1]).not.toContain("meeting_stop");
  });
});

describe("ConversationLoop — deferral ceiling (#1176)", () => {
  it("falls back to deferral at/above the eligible-tool ceiling", async () => {
    // meeting suite base = 2 (meeting_start + meeting_stop). Add enough extra
    // meeting tools to cross EAGER_TOOL_EXPOSURE_CEILING. With deferral on, the
    // non-keyword-preloaded meeting tools must be deferred (catalog), so the
    // model needs tool_search to reach meeting_stop.
    // Headless excludes MCP so the eligible count is exactly the meeting suite.
    const extra = EAGER_TOOL_EXPOSURE_CEILING; // 2 + 200 = 202 eligible >= 200
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: TOOL_SEARCH_TOOL_NAME, input: { query: "meeting_stop" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "tool_call", id: "tu-2", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, extraMeetingTools: extra, headless: true });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("완료");

    // Deferral on: only the keyword-preloaded meeting_start loads up front;
    // meeting_stop is deferred until tool_search promotes it.
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
    // After tool_search the next round sees meeting_stop.
    expect(provider.observedToolNames[1]).toContain("meeting_stop");
  });

  it("does NOT count builtins toward the ceiling (eager just below it)", async () => {
    // Headless (no MCP): base meeting suite = 2; add (ceiling - 3) extra →
    // eligible = ceiling - 1 (199 when ceiling is 200). Many builtins exist
    // (tool_search etc.) but the turn must stay eager because builtins are
    // excluded from the count.
    const extra = EAGER_TOOL_EXPOSURE_CEILING - 3;
    const provider = new RecordingProvider([
      [
        { type: "tool_call", id: "tu-1", name: "meeting_stop", input: {} },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, extraMeetingTools: extra, headless: true });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("완료");

    // Eager (eligible = ceiling - 1 < ceiling): meeting_stop loaded directly,
    // no tool_search needed.
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
    const searchCalls = loop
      .getHistory()
      .getMessages()
      .filter((m) => m.role === "tool_result" && m.toolName === TOOL_SEARCH_TOOL_NAME);
    expect(searchCalls).toHaveLength(0);
  });

  it("treats exactly the ceiling as the deferral boundary", async () => {
    // Headless (no MCP): base meeting suite = 2; add (ceiling - 2) → eligible =
    // exactly ceiling → deferral on (>= is inclusive).
    const extra = EAGER_TOOL_EXPOSURE_CEILING - 2;
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "ok" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, extraMeetingTools: extra, headless: true });
    await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    // Deferral on at exactly the ceiling: meeting_stop is deferred (not loaded).
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).not.toContain("meeting_stop");
    expect(provider.observedToolNames[0]).toContain(TOOL_SEARCH_TOOL_NAME);
  });
});

describe("ConversationLoop — headless MCP scope (#1176 eager)", () => {
  it("keeps MCP tools out of a headless turn (eager mode, no MCP in scope)", async () => {
    const provider = new RecordingProvider([
      [
        { type: "text_delta", text: "no mcp" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop({ provider, headless: true });
    const result = await loop.runTurn("회의 정리해줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    expect(result.text).toBe("no mcp");
    // Headless excludes MCP entirely; meeting suite is eager.
    expect(provider.observedToolNames[0]).not.toContain("mcp_fetch");
    expect(provider.observedToolNames[0]).toContain("meeting_start");
    expect(provider.observedToolNames[0]).toContain("meeting_stop");
  });
});
