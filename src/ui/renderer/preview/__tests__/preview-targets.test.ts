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

  it("promotes path-bearing search hits to inline-text file previews (indexer)", () => {
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g1",
        groupIds: ["g1"],
        status: "done",
        tools: [
          {
            toolUseId: "search-1",
            name: "index_search",
            displayOrder: 0,
            status: "done",
            source: "plugin",
            pluginId: "local-indexer",
            input: { query: "budget", mode: "hybrid", topK: 5 },
            result: JSON.stringify({
              hits: [
                { chunkId: "c1", docId: "d1", docName: "plan.md", page: 3, path: "/docs/plan.md", snippet: "# Plan\n\nbudget" },
                { chunkId: "c2", docId: "d2", docName: "notes.txt", path: "/docs/notes.txt", rawText: "plain notes" },
                { chunkId: "c3", docId: "d3", docName: "no-path" },
              ],
            }),
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });

    const planTarget = model.targets.find((t) => t.kind === "file" && t.title === "plan.md");
    expect(planTarget).toBeTruthy();
    expect(planTarget && "inlineText" in planTarget && planTarget.inlineText).toContain("# Plan");
    expect(planTarget?.subtitle).toContain("page 3");

    const notesTarget = model.targets.find((t) => t.kind === "file" && t.title === "notes.txt");
    expect(notesTarget && "inlineText" in notesTarget && notesTarget.inlineText).toBe("plain notes");

    // The hit without a path is not promoted.
    expect(model.targets.some((t) => t.title === "no-path")).toBe(false);
    // With hits present, no generic json card is created for the same tool.
    expect(model.targets.some((t) => t.kind === "json" && t.toolUseId === "search-1")).toBe(false);
    // Hits also surface in the file-browser tree.
    expect(model.files.some((f) => f.path === "/docs/plan.md" && f.operation === "read")).toBe(true);
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

  it("captures a bare working-dir filename written by write_file into the session files list", () => {
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g-write",
        groupIds: ["g-write"],
        status: "done",
        tools: [
          {
            toolUseId: "write-bare-1",
            name: "write_file",
            displayOrder: 0,
            status: "done",
            category: "write",
            // A bare filename with NO directory separator — the shape the model
            // produces when writing into the working directory by name.
            input: { path: "2026-07-03.md", content: "# Notes" },
            result: JSON.stringify({ kind: "lvis.write_file", path: "2026-07-03.md" }),
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });

    // The bare-name write appears in the session files list as a write, linked to
    // an openable file target (clicking it opens the preview).
    const file = model.files.find((item) => item.path === "2026-07-03.md");
    expect(file).toEqual(
      expect.objectContaining({
        path: "2026-07-03.md",
        label: "2026-07-03.md",
        operation: "write",
        previewTargetId: "file:write-bare-1:2026-07-03.md",
      }),
    );
    // The linked preview target exists so the click resolves to a real preview.
    expect(
      model.targets.some(
        (tgt) => tgt.id === "file:write-bare-1:2026-07-03.md" && "path" in tgt && tgt.path === "2026-07-03.md",
      ),
    ).toBe(true);
  });

  it("does not treat free-text tokens in a tool's content field as session files", () => {
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g-content",
        groupIds: ["g-content"],
        status: "done",
        tools: [
          {
            toolUseId: "write-content-1",
            name: "write_file",
            displayOrder: 0,
            status: "done",
            category: "write",
            // The `content` body mentions filename-like tokens; only the `path`
            // key vouches for a real file, so the body must NOT leak entries.
            input: { path: "report.md", content: "see index.ts and config.json" },
            result: JSON.stringify({ kind: "lvis.write_file", path: "report.md" }),
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });

    expect(model.files.some((item) => item.path === "report.md")).toBe(true);
    // Bare filenames inside the content blob (non-path key) are not files.
    expect(model.files.some((item) => item.path === "index.ts")).toBe(false);
    expect(model.files.some((item) => item.path === "config.json")).toBe(false);
  });

  it("does not turn a glob pattern into a file target, but promotes its matches (diagnosis ③)", () => {
    const entries: ChatEntry[] = [
      {
        kind: "tool_group",
        groupId: "g-glob",
        groupIds: ["g-glob"],
        status: "done",
        tools: [
          {
            toolUseId: "glob-1",
            name: "glob_files",
            displayOrder: 0,
            status: "done",
            category: "read",
            input: { pattern: "**/*architecture*.md", path: "/workspace" },
            result: JSON.stringify({
              path: "/workspace",
              pattern: "**/*architecture*.md",
              matches: ["/workspace/docs/architecture.md", "/workspace/docs/architecture-v4.md"],
              truncated: false,
            }),
          },
        ],
      },
    ];

    const model = collectChatPreviewModel({ entries, attachments: [] });

    // The glob pattern itself never becomes a file target/entry.
    expect(model.targets.some((tgt) => "path" in tgt && tgt.path.includes("**"))).toBe(false);
    expect(model.files.some((item) => item.path.includes("**"))).toBe(false);

    // Its concrete matches ARE openable file targets.
    expect(model.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "file", title: "architecture.md", path: "/workspace/docs/architecture.md" }),
        expect.objectContaining({ kind: "file", title: "architecture-v4.md", path: "/workspace/docs/architecture-v4.md" }),
      ]),
    );
    expect(model.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/workspace/docs/architecture.md", operation: "read", canOpenExternal: false }),
      ]),
    );
    // With matches present, no generic json card collapses the same tool.
    expect(model.targets.some((tgt) => tgt.kind === "json" && tgt.toolUseId === "glob-1")).toBe(false);
  });
});
