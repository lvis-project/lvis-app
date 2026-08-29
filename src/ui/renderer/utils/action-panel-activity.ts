import type { ChatEntry, ToolEntryItem } from "../../../lib/chat-stream-state.js";
import type {
  ActionPanelActivityItem,
  ActionPanelActivityState,
} from "../components/ActionPanel.js";
import {
  FILE_WRITE_TOOL_NAMES,
  READ_TOOL_PATTERN,
  TOOL_PATH_KEYS,
  TOOL_URL_PATTERN,
  extractPatchPaths,
  isGlobPattern,
} from "./tool-input-paths.js";
import { isRecord } from "../../../shared/is-record.js";

/**
 * How many rows one activity list shows. Exported because the chat preview
 * model bounds its web-artifact list by the same number: the Browser tab and
 * this panel are two views of one set of fetched pages, and a bound that lived
 * on only one side would let a single link-heavy result grow the other without
 * limit.
 */
export const ACTION_PANEL_ACTIVITY_LIMIT = 5;
const ACTION_PANEL_ICON_LIMIT = 10;
const TERMINAL_TOOL_PATTERN = /(^|[._:-])(shell|bash|cmd|powershell|terminal|exec|run)([._:-]|$)/i;
const BROWSER_TOOL_PATTERN = /(browser|playwright|screenshot|chrome|viewport|open_url|web_page|web_fetch|web_search|web_patch|fetch)/i;

export function isFileChangeTool(tool: ToolEntryItem): boolean {
  return FILE_WRITE_TOOL_NAMES.has(tool.name) || tool.category === "write";
}

export function isReadTool(tool: ToolEntryItem): boolean {
  return tool.category === "read" || READ_TOOL_PATTERN.test(tool.name);
}

export function isTerminalTool(tool: ToolEntryItem): boolean {
  return tool.category === "shell" || TERMINAL_TOOL_PATTERN.test(tool.name);
}

/**
 * Does this call fetch web pages? Shared with the chat preview model
 * (`preview/preview-targets.ts`), which builds the side panel's Browser tab
 * from the same predicate — the tab and this panel list one set of pages, so
 * they must agree on which calls produce them.
 */
export function isBrowserTool(tool: ToolEntryItem): boolean {
  return tool.category === "network" || BROWSER_TOOL_PATTERN.test(tool.name);
}

export function isPluginTool(tool: ToolEntryItem): boolean {
  return tool.source === "plugin" || Boolean(tool.pluginId);
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function looksLikeFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || looksLikeUrl(trimmed)) return false;
  // A glob is a tool argument, never a concrete file. The preview derivation
  // has always excluded it; without the same guard here an action-panel row
  // for `src/**` can never resolve against the preview model.
  if (isGlobPattern(trimmed)) return false;
  return /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

/**
 * Every http(s) URL reachable in a tool's arguments or result, with trailing
 * prose punctuation trimmed (`(https://x/y)` in a summary is the page, not the
 * bracket). Shared with `preview/preview-targets.ts`: two collectors would give
 * the Browser tab and this panel different page lists for the same turn.
 *
 * Bounded at four levels of nesting, which is the shape a tool's arguments and
 * a decoded JSON result actually take. A URL buried deeper than that is inside
 * a payload the tool is carrying rather than a page it fetched, and the bound
 * is also what stops a pathological result from walking without end.
 */
export function collectUrls(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (looksLikeUrl(trimmed)) return [trimmed.replace(/[),.;]+$/g, "")];
    return Array.from(value.matchAll(TOOL_URL_PATTERN), (match) => match[0].replace(/[),.;]+$/g, ""));
  }
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
    if (TOOL_PATH_KEYS.has(normalizedKey)) {
      out.push(...collectPathStrings(child, depth + 1));
    } else if (normalizedKey === "patch" && typeof child === "string") {
      out.push(...extractPatchPaths(child));
    } else if (depth < 2) {
      out.push(...collectPathStrings(child, depth + 1));
    }
  }
  return out;
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
        for (const url of new Set([...collectUrls(tool.input), ...collectUrls(tool.result)])) {
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
            target: path,
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
            target: path,
            status: tool.status,
          });
        }
      }
    }
  }

  return activity;
}
