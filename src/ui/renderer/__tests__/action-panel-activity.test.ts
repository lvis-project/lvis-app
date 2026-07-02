import { describe, it, expect } from "vitest";
import type { ChatEntry, ToolEntryItem } from "../../../lib/chat-stream-state.js";
import {
  computeActionPanelActivity,
  isFileChangeTool,
  isReadTool,
  isTerminalTool,
  isBrowserTool,
  isPluginTool,
  looksLikeUrl,
  looksLikeFilePath,
  collectUrls,
  collectPathStrings,
  extractPatchPaths,
  formatToolSource,
  formatUrlOrigin,
} from "../utils/action-panel-activity.js";

function tool(partial: Partial<ToolEntryItem> & { name: string }): ToolEntryItem {
  return {
    toolUseId: partial.toolUseId ?? `tu-${partial.name}`,
    displayOrder: partial.displayOrder ?? 0,
    status: partial.status ?? "done",
    ...partial,
  };
}

function toolGroup(tools: ToolEntryItem[]): ChatEntry {
  return { kind: "tool_group", groupId: "g1", groupIds: ["g1"], status: "done", tools };
}

describe("action-panel-activity — tool classifiers", () => {
  it("isFileChangeTool matches known names and write category", () => {
    expect(isFileChangeTool(tool({ name: "write_file" }))).toBe(true);
    expect(isFileChangeTool(tool({ name: "apply_patch" }))).toBe(true);
    expect(isFileChangeTool(tool({ name: "edit_file" }))).toBe(true);
    expect(isFileChangeTool(tool({ name: "custom", category: "write" }))).toBe(true);
    expect(isFileChangeTool(tool({ name: "read_file" }))).toBe(false);
  });

  it("isReadTool matches read category and read-ish names", () => {
    expect(isReadTool(tool({ name: "anything", category: "read" }))).toBe(true);
    expect(isReadTool(tool({ name: "grep_search" }))).toBe(true);
    expect(isReadTool(tool({ name: "list_dir" }))).toBe(true);
    expect(isReadTool(tool({ name: "write_file" }))).toBe(false);
  });

  it("isTerminalTool matches shell category and terminal-ish names", () => {
    expect(isTerminalTool(tool({ name: "run_bash", category: "shell" }))).toBe(true);
    expect(isTerminalTool(tool({ name: "powershell" }))).toBe(true);
    expect(isTerminalTool(tool({ name: "read_file" }))).toBe(false);
  });

  it("isBrowserTool matches network category and browser-ish names", () => {
    expect(isBrowserTool(tool({ name: "x", category: "network" }))).toBe(true);
    expect(isBrowserTool(tool({ name: "web_fetch" }))).toBe(true);
    expect(isBrowserTool(tool({ name: "playwright_click" }))).toBe(true);
    expect(isBrowserTool(tool({ name: "read_file" }))).toBe(false);
  });

  it("isPluginTool matches plugin source or pluginId", () => {
    expect(isPluginTool(tool({ name: "x", source: "plugin" }))).toBe(true);
    expect(isPluginTool(tool({ name: "x", pluginId: "meeting" }))).toBe(true);
    expect(isPluginTool(tool({ name: "x", source: "builtin" }))).toBe(false);
  });
});

describe("action-panel-activity — string predicates + collectors", () => {
  it("looksLikeUrl", () => {
    expect(looksLikeUrl("https://example.com")).toBe(true);
    expect(looksLikeUrl("  http://a.b  ")).toBe(true);
    expect(looksLikeUrl("/usr/local")).toBe(false);
    expect(looksLikeUrl("example.com")).toBe(false);
  });

  it("looksLikeFilePath", () => {
    expect(looksLikeFilePath("/usr/local/bin")).toBe(true);
    expect(looksLikeFilePath("C:\\Users\\x")).toBe(true);
    expect(looksLikeFilePath("./rel/path")).toBe(true);
    expect(looksLikeFilePath("report.txt")).toBe(true);
    expect(looksLikeFilePath("https://example.com")).toBe(false);
    expect(looksLikeFilePath("plainword")).toBe(false);
  });

  it("collectUrls walks nested structures", () => {
    expect(collectUrls({ a: "https://a.com", b: ["https://b.com", "nope"] })).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(collectUrls("not a url")).toEqual([]);
  });

  it("collectPathStrings prefers path-like keys and parses patches", () => {
    expect(collectPathStrings({ path: "/a/b.ts" })).toEqual(["/a/b.ts"]);
    expect(collectPathStrings({ patch: "*** Update File: src/x.ts\n" })).toEqual(["src/x.ts"]);
  });

  it("extractPatchPaths parses Add/Update/Delete headers", () => {
    const patch = "*** Add File: a.ts\n*** Update File: b.ts\n*** Delete File: c.ts\n";
    expect(extractPatchPaths(patch)).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("formatToolSource joins non-builtin source parts", () => {
    expect(formatToolSource(tool({ name: "x", source: "mcp", mcpServerId: "srv", category: "read" }))).toBe(
      "mcp · srv · read",
    );
    expect(formatToolSource(tool({ name: "x", source: "builtin" }))).toBe("");
  });

  it("formatUrlOrigin returns origin or the raw value on parse failure", () => {
    expect(formatUrlOrigin("https://a.com/x?y=1")).toBe("https://a.com");
    expect(formatUrlOrigin("not-a-url")).toBe("not-a-url");
  });
});

describe("computeActionPanelActivity", () => {
  it("returns an empty summary for no tool groups", () => {
    const activity = computeActionPanelActivity([{ kind: "user", text: "hi" }] as ChatEntry[]);
    expect(activity.toolCallCount).toBe(0);
    expect(activity.readFiles).toEqual([]);
    expect(activity.writtenFiles).toEqual([]);
  });

  it("aggregates counts and dedupes across tool groups", () => {
    const entries: ChatEntry[] = [
      toolGroup([
        tool({ name: "write_file", toolUseId: "w1", input: { path: "/a.ts" } }),
        tool({ name: "read_file", toolUseId: "r1", input: { path: "/b.ts" } }),
        tool({ name: "meeting_open", toolUseId: "p1", pluginId: "meeting" }),
        tool({ name: "srv_call", toolUseId: "m1", source: "mcp", mcpServerId: "srv" }),
        tool({ name: "web_fetch", toolUseId: "u1", input: { url: "https://x.com/page" } }),
      ]),
    ];
    const activity = computeActionPanelActivity(entries);
    expect(activity.toolCallCount).toBe(5);
    expect(activity.writtenFileCount).toBe(1);
    expect(activity.readFileCount).toBe(1);
    expect(activity.pluginCallCount).toBe(1);
    expect(activity.mcpCallCount).toBe(1);
    expect(activity.fetchedPageCount).toBe(1);
    expect(activity.writtenFiles[0]?.label).toBe("/a.ts");
    expect(activity.readFiles[0]?.label).toBe("/b.ts");
    expect(activity.fetchedPages[0]?.label).toBe("https://x.com");
    expect(activity.fetchedPages[0]?.target).toBe("https://x.com/page");
    // Read/written rows carry their path as `target` so ActionPanel can route
    // them to an in-app preview (§6.10.5). No opener is triggered — the target
    // is only a routing key.
    expect(activity.writtenFiles[0]?.target).toBe("/a.ts");
    expect(activity.readFiles[0]?.target).toBe("/b.ts");
  });
});
