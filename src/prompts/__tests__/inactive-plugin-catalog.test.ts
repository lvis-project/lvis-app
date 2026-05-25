/**
 * SystemPromptBuilder requestable plugin catalog section.
 *
 * Verifies:
 *   - Enabled, runtime-loaded plugins outside the current turn scope appear
 *     under the request_plugin catalog
 *   - Active plugin (in scope) is omitted from catalog
 *   - Empty cards → section omitted
 */
import { describe, it, expect } from "vitest";

import { SystemPromptBuilder } from "../system-prompt-builder.js";
import { ToolRegistry } from "../../tools/registry.js";

function makeBuilder(cards: Array<{
  id: string;
  name: string;
  description: string;
  sampleTools: string[];
  active?: boolean;
  runtimeLoaded?: boolean;
  loadStatus?: "loaded" | "preparing" | "failed" | "disabled";
}>): SystemPromptBuilder {
  return new SystemPromptBuilder({
    memoryManager: {
      getAgentsMd: () => "",
      getLvisMd: () => "",
      getMemoryIndex: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
    getPluginCards: () => cards,
  });
}

describe("SystemPromptBuilder — inactive plugin catalog", () => {
  it("renders inactive plugins with bold id + sample tools", () => {
    const builder = makeBuilder([
      {
        id: "example-meeting",
        name: "Meeting",
        description: "회의 녹음/요약",
        sampleTools: ["meeting_start", "meeting_stop"],
      },
      {
        id: "docs-plugin",
        name: "Docs Plugin",
        description: "문서 인덱스/검색",
        sampleTools: ["document_scan", "document_search"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).toContain("## 사용 가능한 플러그인 (현재 턴 미선택 — request_plugin 으로 선택)");
    expect(prompt).toContain("**example-meeting**");
    expect(prompt).toContain("meeting_start, meeting_stop");
    expect(prompt).toContain("**docs-plugin**");
  });

  it("omits active plugin from catalog", () => {
    const builder = makeBuilder([
      {
        id: "example-meeting",
        name: "Meeting",
        description: "회의 녹음/요약",
        sampleTools: ["meeting_start"],
      },
      {
        id: "example-email",
        name: "Email",
        description: "이메일",
        sampleTools: ["email_list"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["example-meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("**example-meeting**");
    expect(prompt).toContain("**example-email**");
  });

  it("section omitted when no cards", () => {
    const builder = makeBuilder([]);
    builder.setToolScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("사용 가능한 플러그인");
  });

  it("section omitted when all cards are active", () => {
    const builder = makeBuilder([
      {
        id: "example-meeting",
        name: "Meeting",
        description: "회의",
        sampleTools: ["meeting_start"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["example-meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("사용 가능한 플러그인");
  });

  it("omits user-disabled loaded plugins because request_plugin cannot select them", () => {
    const builder = makeBuilder([
      {
        id: "example-disabled",
        name: "Disabled",
        description: "사용자가 비활성화한 플러그인",
        sampleTools: ["disabled_tool"],
        active: false,
        runtimeLoaded: true,
        loadStatus: "disabled",
      },
      {
        id: "example-enabled",
        name: "Enabled",
        description: "현재 턴에만 미선택",
        sampleTools: ["enabled_tool"],
        active: true,
        runtimeLoaded: true,
        loadStatus: "loaded",
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("**example-disabled**");
    expect(prompt).not.toContain("disabled_tool");
    expect(prompt).toContain("**example-enabled**");
  });

  it("omits plugins with no policy-visible sample tools", () => {
    const builder = makeBuilder([
      {
        id: "example-denied",
        name: "Denied",
        description: "모든 도구가 정책상 숨겨짐",
        sampleTools: [],
        active: true,
        runtimeLoaded: true,
        loadStatus: "loaded",
      },
      {
        id: "example-visible",
        name: "Visible",
        description: "선택 가능한 도구 있음",
        sampleTools: ["visible_tool"],
        active: true,
        runtimeLoaded: true,
        loadStatus: "loaded",
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("**example-denied**");
    expect(prompt).toContain("**example-visible**");
  });
});
