/**
 * Phase 1 Lazy Tool Scoping — resolveToolScope() fallback/reuse semantics.
 *
 * Verifies:
 *   1. Keyword match → only matched plugin's tools + builtins sent to provider.
 *   2. Subsequent turn with no keyword match → reuses previous turn's plugin scope.
 *   3. First turn with no keyword match → builtins + MCP only (empty plugin set).
 */
import { describe, it, expect } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";

/** A provider that captures the tool names passed each turn and returns immediately. */
class CapturingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly capturedToolNames: string[][] = [];

  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.capturedToolNames.push((params.tools ?? []).map((t) => t.name));
    yield { type: "text_delta", text: "응답" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function buildDeps(toolRegistry: ToolRegistry, keywordEngine: KeywordEngine) {
  const routeEngine = new RouteEngine({ toolRegistry });
  return {
    settingsService: {
      get: () => ({ provider: "openai", model: "gpt-4o" }),
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
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0];
}

function buildRegistry() {
  const r = new ToolRegistry();
  r.register(createDynamicTool({
    name: "bash",
    description: "run bash",
    source: "builtin",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  r.register(createDynamicTool({
    name: "meeting_start",
    description: "start meeting",
    source: "plugin",
    pluginId: "com.lge.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  r.register(createDynamicTool({
    name: "email_list",
    description: "list emails",
    source: "plugin",
    pluginId: "com.lge.email",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  return r;
}

describe("ConversationLoop resolveToolScope — Phase 1 Lazy Tool Scoping", () => {
  it("keyword match → only matched plugin tools + builtins forwarded to provider", async () => {
    const toolRegistry = buildRegistry();
    const keywordEngine = new KeywordEngine();
    keywordEngine.registerKeywords([
      { keyword: "회의", skillId: "meeting.start", pluginId: "com.lge.meeting" },
      { keyword: "이메일", skillId: "email.list", pluginId: "com.lge.email" },
    ]);

    const provider = new CapturingProvider();
    const loop = new ConversationLoop(buildDeps(toolRegistry, keywordEngine));
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("오늘 회의 내용 정리해줘");

    const toolNames = provider.capturedToolNames[0].sort();
    // Only meeting plugin tools + builtins; email tools excluded
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("meeting_start");
    expect(toolNames).not.toContain("email_list");
  });

  it("subsequent turn with no keyword match → reuses previous turn's plugin scope", async () => {
    const toolRegistry = buildRegistry();
    const keywordEngine = new KeywordEngine();
    keywordEngine.registerKeywords([
      { keyword: "회의", skillId: "meeting.start", pluginId: "com.lge.meeting" },
    ]);

    const provider = new CapturingProvider();
    const loop = new ConversationLoop(buildDeps(toolRegistry, keywordEngine));
    (loop as { provider: LLMProvider | null }).provider = provider;

    // Turn 1: keyword match — meeting scope established
    await loop.runTurn("회의 시작해줘");
    // Turn 2: no keyword match — should reuse meeting scope from turn 1
    await loop.runTurn("방금 그거 계속 진행해줘");

    const turn2Tools = provider.capturedToolNames[1].sort();
    expect(turn2Tools).toContain("bash");
    expect(turn2Tools).toContain("meeting_start");
    expect(turn2Tools).not.toContain("email_list");
  });

  it("first turn with no keyword match → builtins + MCP only (empty plugin set)", async () => {
    const toolRegistry = buildRegistry();
    // Add an MCP tool to verify it's included
    toolRegistry.register(createDynamicTool({
      name: "mcp_fetch",
      description: "mcp tool",
      source: "mcp",
      mcpServerId: "server-1",
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "", isError: false }),
    }));

    const keywordEngine = new KeywordEngine();
    keywordEngine.registerKeywords([
      { keyword: "회의", skillId: "meeting.start", pluginId: "com.lge.meeting" },
    ]);

    const provider = new CapturingProvider();
    const loop = new ConversationLoop(buildDeps(toolRegistry, keywordEngine));
    (loop as { provider: LLMProvider | null }).provider = provider;

    // Pure chat — no keyword match, no prior turn
    await loop.runTurn("날씨 어때?");

    const toolNames = provider.capturedToolNames[0].sort();
    expect(toolNames).toContain("bash");
    expect(toolNames).toContain("mcp_fetch");
    expect(toolNames).not.toContain("meeting_start");
    expect(toolNames).not.toContain("email_list");
  });
});
