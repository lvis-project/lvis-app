import { describe, expect, it } from "vitest";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { Attachment } from "../../types/attachments.js";
import { collectChatPreviewModel } from "../preview-targets.js";

describe("collectChatPreviewModel", () => {
  it("collects attachment files and tool file paths without granting tool paths external-open rights", () => {
    const attachments: Attachment[] = [
      {
        id: "att-1",
        n: 1,
        kind: "file",
        path: "C:\\workspace\\notes.md",
        name: "notes.md",
        ext: "md",
        bytes: 2048,
      },
    ];
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g1",
        groupIds: ["g1"],
        status: "done",
        tools: [
          {
            toolUseId: "read-1",
            name: "read_file",
            displayOrder: 0,
            status: "done",
            category: "read",
            input: { path: "C:\\workspace\\report.md" },
            result: "# Report",
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments });

    expect(model.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "C:\\workspace\\notes.md",
          operation: "attachment",
          canOpenExternal: true,
        }),
        expect.objectContaining({
          path: "C:\\workspace\\report.md",
          operation: "read",
          canOpenExternal: false,
        }),
      ]),
    );
    expect(model.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", title: "notes.md", canOpenExternal: true }),
        expect.objectContaining({ kind: "file", title: "report.md", canOpenExternal: false }),
      ]),
    );
  });

  it("collects render_html, write diffs, urls, json, and MCP app payloads", () => {
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g1",
        groupIds: ["g1"],
        status: "done",
        tools: [
          {
            toolUseId: "html-1",
            name: "render_html",
            displayOrder: 0,
            status: "done",
            input: {},
            result: JSON.stringify({ kind: "lvis.render_html", title: "Dashboard", html: "<h1>Hi</h1>", height: 320 }),
          },
          {
            toolUseId: "write-1",
            name: "write_file",
            displayOrder: 1,
            status: "done",
            category: "write",
            input: { path: "C:\\workspace\\out.json" },
            result: JSON.stringify({
              kind: "lvis.write_file",
              path: "C:\\workspace\\out.json",
              before: "{}",
              after: "{\"ok\":true}",
            }),
          },
          {
            toolUseId: "web-1",
            name: "web_fetch",
            displayOrder: 2,
            status: "done",
            category: "network",
            input: { url: "https://example.com/docs" },
            result: "{\"status\":200}",
          },
          {
            toolUseId: "app-1",
            name: "mcp_app",
            displayOrder: 3,
            status: "done",
            input: {},
            result: "done",
            uiPayload: {
              serverId: "server-a",
              resourceUri: "ui://server-a/card",
              slot: "sidebar",
              title: "Plugin Card",
            },
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });

    expect(model.targets.map((target) => target.kind)).toEqual(
      expect.arrayContaining(["html", "diff", "url", "json", "plugin"]),
    );
    expect(model.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "html", title: "Dashboard" }),
        expect.objectContaining({ kind: "diff", path: "C:\\workspace\\out.json" }),
        expect.objectContaining({ kind: "url", url: "https://example.com/docs" }),
        expect.objectContaining({ kind: "plugin", resourceUri: "ui://server-a/card" }),
      ]),
    );
    expect(model.targets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool-result", toolUseId: "app-1" }),
      ]),
    );
  });

  it("promotes a repeated tool file entry to write when a later diff touches the same path", () => {
    const path = "C:\\workspace\\report.md";
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g1",
        groupIds: ["g1"],
        status: "done",
        tools: [
          {
            toolUseId: "read-1",
            name: "read_file",
            displayOrder: 0,
            status: "done",
            category: "read",
            input: { path },
            result: "# Before",
          },
          {
            toolUseId: "write-1",
            name: "write_file",
            displayOrder: 1,
            status: "done",
            category: "write",
            input: { path },
            result: JSON.stringify({
              kind: "lvis.write_file",
              path,
              before: "# Before\n",
              after: "# After\n",
            }),
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });
    const file = model.files.find((item) => item.path === path);

    expect(file).toEqual(
      expect.objectContaining({
        operation: "write",
        previewTargetId: `diff:write-1:${path}`,
        canOpenExternal: false,
      }),
    );
  });
});
