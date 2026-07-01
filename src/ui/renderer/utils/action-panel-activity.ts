import type { ChatEntry, ToolEntryItem } from "../../../lib/chat-stream-state.js";
import type {
  ActionPanelActivityItem,
  ActionPanelActivityState,
} from "../components/ActionPanel.js";

const ACTION_PANEL_ACTIVITY_LIMIT = 5;
const ACTION_PANEL_ICON_LIMIT = 10;
const FILE_CHANGE_TOOL_NAMES = new Set(["edit_file", "apply_patch", "write_file"]);
const READ_TOOL_PATTERN = /(^|[._:-])(read|open|cat|grep|rg|search|find|list|glob)([._:-]|$)/i;
const TERMINAL_TOOL_PATTERN = /(^|[._:-])(shell|bash|cmd|powershell|terminal|exec|run)([._:-]|$)/i;
const BROWSER_TOOL_PATTERN = /(browser|playwright|screenshot|chrome|viewport|open_url|web_page|web_fetch|fetch)/i;
const ACTION_PANEL_PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "filepath",
  "filepaths",
  "filename",
  "filenames",
  "target",
  "targets",
]);

export function isFileChangeTool(tool: ToolEntryItem): boolean {
  return FILE_CHANGE_TOOL_NAMES.has(tool.name) || tool.category === "write";
}

export function isReadTool(tool: ToolEntryItem): boolean {
  return tool.category === "read" || READ_TOOL_PATTERN.test(tool.name);
}

export function isTerminalTool(tool: ToolEntryItem): boolean {
  return tool.category === "shell" || TERMINAL_TOOL_PATTERN.test(tool.name);
}

export function isBrowserTool(tool: ToolEntryItem): boolean {
  return tool.category === "network" || BROWSER_TOOL_PATTERN.test(tool.name);
}

export function isPluginTool(tool: ToolEntryItem): boolean {
  return tool.source === "plugin" || Boolean(tool.pluginId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksLikeUrl(trimmed)) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

export function collectUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return looksLikeUrl(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectUrls(item, depth + 1));
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((item) => collectUrls(item, depth + 1));
}

export function collectPathStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") return looksLikeFilePath(value) ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectPathStrings(item, depth + 1));
  if (!isRecord(value)) return [];

  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (ACTION_PANEL_PATH_KEYS.has(normalizedKey)) {
      out.push(...collectPathStrings(child, depth + 1));
    } else if (normalizedKey === "patch" && typeof child === "string") {
      out.push(...extractPatchPaths(child));
    } else if (depth < 2) {
      out.push(...collectPathStrings(child, depth + 1));
    }
  }
  return out;
}

export function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const pattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(patch)) !== null) {
    const value = match[1]?.trim();
    if (value) paths.push(value);
  }
  return paths;
}

export function addUniqueActivity(
  list: ActionPanelActivityItem[],
  item: ActionPanelActivityItem,
  limit = ACTION_PANEL_ACTIVITY_LIMIT,
): void {
  if (list.length >= limit) return;
  const key = `${item.label}\u0000${item.detail ?? ""}`;
  if (list.some((existing) => `${existing.label}\u0000${existing.detail ?? ""}` === key)) return;
  list.push(item);
}

export function formatToolSource(tool: ToolEntryItem): string {
  const parts = [
    tool.source && tool.source !== "builtin" ? tool.source : null,
    tool.mcpServerId ? tool.mcpServerId : null,
    tool.pluginId ? tool.pluginId : null,
    tool.category ? tool.category : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

export function formatUrlOrigin(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return value;
  }
}

/**
 * Derive the ActionPanel activity summary (read/written files, plugin/mcp
 * calls, fetched pages) from the current chat entries. Pure — walks the
 * entries newest-first and dedupes by activity key. Extracted from App.tsx
 * (C14) so it can be unit-tested directly; App wraps it in a `useMemo`.
 */
export function computeActionPanelActivity(entries: ChatEntry[]): ActionPanelActivityState {
  const activity: ActionPanelActivityState = {
    readFileCount: 0,
    writtenFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    writtenFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    fetchedPages: [],
  };
  const visibleEntries = entries;
  const readFileKeys = new Set<string>();
  const writtenFileKeys = new Set<string>();
  const fetchedPageKeys = new Set<string>();

  for (let entryIndex = visibleEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = visibleEntries[entryIndex];
    if (entry.kind !== "tool_group") continue;

    for (let toolIndex = entry.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = entry.tools[toolIndex];
      const source = formatToolSource(tool);
      const sourceDetail = source || (isTerminalTool(tool) ? "terminal" : isBrowserTool(tool) ? "web" : undefined);

      activity.toolCallCount += 1;
      if (isPluginTool(tool)) {
        activity.pluginCallCount += 1;
        addUniqueActivity(activity.pluginCalls, {
          id: `plugin:${tool.toolUseId}`,
          label: tool.name,
          detail: tool.pluginId ?? sourceDetail,
          status: tool.status,
        }, ACTION_PANEL_ICON_LIMIT);
      }

      if (tool.source === "mcp" || tool.mcpServerId) {
        activity.mcpCallCount += 1;
        addUniqueActivity(activity.mcpCalls, {
          id: `mcp:${tool.toolUseId}`,
          label: tool.name,
          detail: tool.mcpServerId ?? sourceDetail,
          status: tool.status,
        }, ACTION_PANEL_ICON_LIMIT);
      }

      if (isBrowserTool(tool)) {
        for (const url of new Set(collectUrls(tool.input))) {
          if (!fetchedPageKeys.has(url)) {
            fetchedPageKeys.add(url);
            activity.fetchedPageCount += 1;
          }
          addUniqueActivity(activity.fetchedPages, {
            id: `url:${tool.toolUseId}:${url}`,
            label: formatUrlOrigin(url),
            detail: url,
            target: url,
            status: tool.status,
          });
        }
      }

      if (isFileChangeTool(tool)) {
        for (const path of new Set(collectPathStrings(tool.input))) {
          if (!writtenFileKeys.has(path)) {
            writtenFileKeys.add(path);
            activity.writtenFileCount += 1;
          }
          addUniqueActivity(activity.writtenFiles, {
            id: `write:${tool.toolUseId}:${path}`,
            label: path,
            detail: tool.name,
            status: tool.status,
          });
        }
      } else if (isReadTool(tool)) {
        for (const path of new Set(collectPathStrings(tool.input))) {
          if (!readFileKeys.has(path)) {
            readFileKeys.add(path);
            activity.readFileCount += 1;
          }
          addUniqueActivity(activity.readFiles, {
            id: `read:${tool.toolUseId}:${path}`,
            label: path,
            detail: tool.name,
            status: tool.status,
          });
        }
      }
    }
  }

  return activity;
}
