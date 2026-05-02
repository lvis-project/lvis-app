/**
 * Phase 1.5 Option C — SystemPromptBuilder catalog section.
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
      getLvisMd: () => "",
      getUserPreferences: () => "",
      getMemoryContext: () => "",
    } as never,
    toolRegistry: new ToolRegistry(),
    getPluginCards: () => cards,
  });
}

describe("SystemPromptBuilder — inactive plugin catalog (Option C)", () => {
  it("renders inactive plugins with bold id + sample tools", () => {
    const builder = makeBuilder([
      {
        id: "com.lge.meeting",
        name: "Meeting",
        description: "회의 녹음/요약",
        sampleTools: ["meeting_start", "meeting_stop"],
      },
      {
        id: "local-indexer",
        name: "Local Indexer",
        description: "문서 인덱스/검색",
        sampleTools: ["index_scan", "index_search"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set<string>(),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).toContain("## 사용 가능한 플러그인 (현재 비활성 — request_plugin 으로 활성화)");
    expect(prompt).toContain("**com.lge.meeting**");
    expect(prompt).toContain("meeting_start, meeting_stop");
    expect(prompt).toContain("**local-indexer**");
  });

  it("omits active plugin from catalog", () => {
    const builder = makeBuilder([
      {
        id: "com.lge.meeting",
        name: "Meeting",
        description: "회의 녹음/요약",
        sampleTools: ["meeting_start"],
      },
      {
        id: "com.lge.email",
        name: "Email",
        description: "이메일",
        sampleTools: ["email_list"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["com.lge.meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("**com.lge.meeting**");
    expect(prompt).toContain("**com.lge.email**");
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
        id: "com.lge.meeting",
        name: "Meeting",
        description: "회의",
        sampleTools: ["meeting_start"],
      },
    ]);
    builder.setToolScope({
      activePluginIds: new Set(["com.lge.meeting"]),
      includeBuiltins: true,
      includeMcp: true,
    });
    const prompt = builder.build();
    expect(prompt).not.toContain("사용 가능한 플러그인");
  });
});
