/**
 * SystemPromptBuilder inactive plugin catalog section.
 *
 * Verifies:
 *   - Inactive plugins appear under "사용 가능한 플러그인 (현재 비활성 …)"
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
        id: "com.example.meeting",
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
    expect(prompt).toContain("## 사용 가능한 플러그인 (현재 비활성 — request_plugin 으로 활성화)");
    expect(prompt).toContain("**com.example.meeting**");
    expect(prompt).toContain("meeting_start, meeting_stop");
    expect(prompt).toContain("**docs-plugin**");
  });

  it("omits active plugin from catalog", () => {
    const builder = makeBuilder([
      {
        id: "com.example.meeting",
        name: "Meeting",
        description: "회의 녹음/요약",
        sampleTools: ["meeting_start"],
      },
      {
        id: "com.example.email",
        name: "Email",
        description: "이메일",
        sampleTools: ["email_list"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("**com.example.meeting**");
    expect(prompt).toContain("**com.example.email**");
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
        id: "com.example.meeting",
        name: "Meeting",
        description: "회의",
        sampleTools: ["meeting_start"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["com.example.meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("사용 가능한 플러그인");
  });
});
