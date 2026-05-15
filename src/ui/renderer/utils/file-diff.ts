import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export type FileDiffTool = "edit_file" | "apply_patch" | "write_file";

export interface FileEditHunk {
  oldText: string;
  newText: string;
}

export interface FileEditDiffData {
  path: string;
  tool: FileDiffTool;
  hunks: FileEditHunk[];
  isNewFile?: boolean;
  truncated?: boolean;
}

type ToolItem = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

export function extractFileEditDiff(tool: ToolItem): FileEditDiffData | null {
  if (tool.status !== "done") return null;
  switch (tool.name) {
    case "edit_file":
      return extractEditFile(tool);
    case "apply_patch":
      return extractApplyPatch(tool);
    case "write_file":
      return extractWriteFile(tool);
    default:
      return null;
  }
}

function extractEditFile(tool: ToolItem): FileEditDiffData | null {
  if (!isRecord(tool.input)) return null;
  const path = readResultField(tool.result, "path") ?? asString(tool.input.path);
  const oldText = asString(tool.input.oldText);
  const newText = asString(tool.input.newText);
  if (path == null || oldText == null || newText == null) return null;
  return { path, tool: "edit_file", hunks: [{ oldText, newText }] };
}

function extractApplyPatch(tool: ToolItem): FileEditDiffData | null {
  if (!isRecord(tool.input)) return null;
  const path = readResultField(tool.result, "path") ?? asString(tool.input.path);
  const reps = tool.input.replacements;
  if (path == null || !Array.isArray(reps)) return null;
  const hunks: FileEditHunk[] = [];
  for (const r of reps) {
    if (!isRecord(r)) continue;
    const o = asString(r.oldText);
    const n = asString(r.newText);
    if (o != null && n != null) hunks.push({ oldText: o, newText: n });
  }
  if (hunks.length === 0) return null;
  return { path, tool: "apply_patch", hunks };
}

function extractWriteFile(tool: ToolItem): FileEditDiffData | null {
  // write_file embeds before/after in its JSON result via the `lvis.write_file`
  // kind sentinel — see WriteFileTool. Older result shapes without the sentinel
  // (back-compat with pre-PR sessions) yield null so the raw payload still
  // renders through the default ToolPayloadBlock path.
  if (typeof tool.result !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tool.result);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.kind !== "lvis.write_file") return null;
  const path = asString(parsed.path);
  const after = asString(parsed.after);
  if (path == null || after == null) return null;
  const isNewFile = parsed.isNewFile === true;
  const before = asString(parsed.before) ?? "";
  const truncated = parsed.truncated === true;
  return {
    path,
    tool: "write_file",
    isNewFile,
    truncated,
    hunks: [{ oldText: isNewFile ? "" : before, newText: after }],
  };
}

function readResultField(result: string | undefined, field: string): string | null {
  if (typeof result !== "string") return null;
  try {
    const parsed = JSON.parse(result);
    if (isRecord(parsed) && typeof parsed[field] === "string") {
      return parsed[field] as string;
    }
  } catch {
    /* result not JSON — caller falls back to input */
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function countDiffLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}
