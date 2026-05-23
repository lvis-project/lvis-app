/**
 * Tool-Level Deferral — SystemPromptBuilder <tool-catalog> source.
 *
 * Verifies:
 *   - flag ON  → <tool-catalog> lists in-scope, NOT-loaded plugin/mcp tools
 *     with the tool_search instruction; loaded tools are not duplicated.
 *   - flag OFF → no <tool-catalog> section at all (legacy behavior).
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";

function seedRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createDynamicTool({
    name: "meeting_start",
    description: "회의 녹음을 시작합니다.",
    source: "plugin",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  r.register(createDynamicTool({
    name: "meeting_stop",
    description: "회의 녹음을 종료합니다.",
    source: "plugin",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  return r;
}

function makeBuilder(toolRegistry: ToolRegistry): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getLvisMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry,
  });
}

describe("SystemPromptBuilder — tool catalog (Tool-Level Deferral)", () => {
  it("flag ON: renders deferred tools + tool_search instruction", () => {
    const builder = makeBuilder(seedRegistry());
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start"]),
      includeBuiltins: true,
      includeMcp: false,
      deferral: true,
    });
    const prompt = builder.build();
    expect(prompt).toContain("<tool-catalog>");
    expect(prompt).toContain("tool_search");
    // meeting_stop is deferred → present in catalog.
    expect(prompt).toContain("**meeting_stop**");
    // meeting_start is loaded → NOT duplicated in catalog.
    const catalogBlock = prompt.slice(prompt.indexOf("<tool-catalog>"));
    expect(catalogBlock).not.toContain("**meeting_start**");
  });

  it("flag OFF: no tool-catalog section", () => {
    const builder = makeBuilder(seedRegistry());
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: false,
      deferral: false,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("<tool-catalog>");
  });

  it("flag ON but nothing deferred → section omitted", () => {
    const builder = makeBuilder(seedRegistry());
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      activeToolNames: new Set(["meeting_start", "meeting_stop"]),
      includeBuiltins: true,
      includeMcp: false,
      deferral: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("<tool-catalog>");
  });
});
