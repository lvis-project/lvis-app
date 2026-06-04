import { describe, expect, it } from "vitest";

import { createRoutineConversationLoop } from "../conversation.js";
import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../engine/llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class RecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  readonly observedToolNames: string[][] = [];

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.observedToolNames.push((input.tools ?? []).map((tool) => tool.name));
    yield { type: "text_delta", text: "routine done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

function memoryManagerStub() {
  return {
    getAgentsMd: () => "",
    getMemoryIndex: () => "",
    getUserPreferences: () => "",
    getMemoryContext: () => "",
    saveSession: () => Promise.resolve(),
    listSessions: () => [],
    saveSessionMetadata: () => Promise.resolve(),
  };
}

describe("createRoutineConversationLoop — tool-level deferral", () => {
  it("loads tools for explicitly forced routine plugin scope", async () => {
    const toolRegistry = new ToolRegistry();
    const forcedToolName = "routine_forced_tool";
    toolRegistry.register(createDynamicTool({
      name: forcedToolName,
      description: "forced routine tool",
      source: "plugin",
      pluginId: "routine-plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: "ok", isError: false }),
    }));

    const keywordEngine = new KeywordEngine();
    const routeEngine = new RouteEngine({ toolRegistry });
    const provider = new RecordingProvider();
    const loop = createRoutineConversationLoop(({
      settingsService: {
        get: () => fakeLlmSettings(),
        getSecret: () => "test-key",
      },
      keywordEngine,
      routeEngine,
      toolRegistry,
      memoryManager: memoryManagerStub(),
      pluginRuntime: {
        listPluginCards: () => [],
      },
    } as unknown) as Parameters<typeof createRoutineConversationLoop>[0], {
      scope: {
        pluginIds: { mode: "allow", ids: ["routine-plugin"] },
        forcedPluginIds: ["routine-plugin"],
        directories: [],
      },
    });
    (loop as unknown as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("routine fire", undefined, undefined, { inputOrigin: "plugin-emitted" });

    expect(provider.observedToolNames[0]).toContain(forcedToolName);
  });
});
