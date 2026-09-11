import { describe, expect, it } from "vitest";
import type { ChatEntry, ToolEntryItem } from "../../../../lib/chat-stream-state.js";
import { collectFileChanges, computeToolActivity } from "../../utils/tool-activity.js";
import { collectChatPreviewModel } from "../preview-targets.js";

function entriesFor(name: string, input: Record<string, unknown>, status: ToolEntryItem["status"] = "done"): ChatEntry[] {
  const tool: ToolEntryItem = {
    name,
    input,
    category: "write",
    source: "builtin",
    toolUseId: "transfer",
    displayOrder: 0,
    status,
  };
  return [{ kind: "tool_group", groupId: "group", groupIds: ["group"], status: "done", tools: [tool] }];
}

describe("structured transfer file activity", () => {
  it.each([
    ["copy_path", { sourcePath: "/project/source.bin", destinationPath: "/project/copy.bin" }, "/project/copy.bin"],
    ["copy_path", { sourcePath: "assets", destinationPath: "assets-copy" }, "assets-copy"],
    ["copy_path", { sourcePath: "assets", destinationPath: "new assets" }, "new assets"],
    ["extract_archive", { archivePath: "assets.tar.gz", destinationPath: "unpacked" }, "unpacked"],
  ] as const)("%s credits only its exact created destination %j", (name, input, destination) => {
    const entries = entriesFor(name, input);
    const activity = computeToolActivity(entries);
    const preview = collectChatPreviewModel({ entries, attachments: [] });
    expect(activity.changedFileCount).toBe(1);
    expect(activity.changedFiles.map(({ target, operation }) => ({ target, operation }))).toEqual([
      { target: destination, operation: "create" },
    ]);
    expect(preview.files.map(({ path, operation }) => ({ path, operation }))).toEqual([
      { path: destination, operation: "create" },
    ]);
    expect(preview.targets.filter(target => "path" in target).map(target => target.path)).toEqual([destination]);
    expect(preview.files[0]?.canOpenExternal).toBe(false);
  });

  it.each(["copy_path", "extract_archive"])("does not infer a changed source for malformed %s input", name => {
    expect(collectFileChanges({ name, category: "write", input: { sourcePath: "source.txt", archivePath: "source.tar" } })).toEqual([]);
  });

  it.each(["error", "cancelled", "running"] as const)("keeps the %s state visible on an attempted destination", status => {
    const entries = entriesFor("copy_path", { sourcePath: "source", destinationPath: "destination" }, status);
    const activity = computeToolActivity(entries);
    const preview = collectChatPreviewModel({ entries, attachments: [] });
    expect(activity.changedFiles).toHaveLength(1);
    expect(activity.changedFiles[0]).toMatchObject({ target: "destination", status });
    expect(preview.files).toHaveLength(1);
    expect(preview.files[0]).toMatchObject({ path: "destination", status });
    expect(preview.targets.every(target => target.status === status)).toBe(true);
  });

  it("preserves generic write and move classification", () => {
    expect(collectFileChanges({ name: "custom_writer", category: "write", input: { path: "output.txt" } })).toEqual([
      { path: "output.txt", operation: "write" },
    ]);
    expect(collectFileChanges({ name: "move_file", input: { sourcePath: "old.txt", destinationPath: "new.txt" } })).toEqual([
      { path: "old.txt", operation: "move", counterpart: "new.txt" },
      { path: "new.txt", operation: "move", counterpart: "old.txt" },
    ]);
  });
});
