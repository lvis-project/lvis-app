/**
 * Tool-Level Deferral — SystemPromptBuilder <tool-catalog> source.
 *
 * Verifies:
 *   - <tool-catalog> lists in-scope, NOT-loaded plugin/mcp tools
 *     with the tool_search instruction; loaded tools are not duplicated.
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";

function seedRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(createDynamicTool({
    name: "bash",
    description: "명령을 실행합니다.",
    source: "builtin",
    category: "shell",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  r.register(createDynamicTool({
    name: "meeting_start",
    description: "회의 녹음을 시작합니다.",
    source: "plugin",
    category: "read",
    pluginId: "com.example.meeting",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "", isError: false }),
  }));
  r.register(createDynamicTool({
    name: "meeting_stop",
    description: "회의 녹음을 종료합니다.",
    source: "plugin",
    category: "write",
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
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry,
  });
}

describe("SystemPromptBuilder — tool catalog (Tool-Level Deferral)", () => {
  it("renders deferred tools + tool_search instruction", () => {
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
    expect(prompt).toContain("### plugin:com.example.meeting");
    expect(prompt).toContain("plugin:<id>/mcp:<id> 도구를 builtin 으로 설명하지 마세요.");
    // meeting_stop is deferred → present in catalog.
    expect(prompt).toContain("**meeting_stop**");
    // meeting_start is loaded → NOT duplicated in catalog.
    const catalogBlock = prompt.slice(prompt.indexOf("<tool-catalog>"));
    expect(catalogBlock).not.toContain("**meeting_start**");
  });

  it("omits catalog when deferral=false because eager mode exposes the full suite", () => {
    const builder = makeBuilder(seedRegistry());
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: false,
      deferral: false,
    });
    const prompt = builder.build();
    expect(prompt).toContain("<available-tools>");
    expect(prompt).toContain("현재 로드되어 있어도 builtin 이라는 뜻은 아닙니다.");
    expect(prompt).toContain("### builtin");
    expect(prompt).toContain("### plugin:com.example.meeting");
    expect(prompt).toContain("**meeting_start**");
    expect(prompt).toContain("**meeting_stop**");
    expect(prompt).not.toContain("<tool-catalog>");
    expect(prompt).not.toContain("사용하려면 먼저 `tool_search({query})`");
  });

  it("nothing deferred → section omitted", () => {
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
