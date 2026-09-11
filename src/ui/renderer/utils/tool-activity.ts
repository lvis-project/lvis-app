import type { ChatEntry, ToolEntryItem } from "../../../lib/chat-stream-state.js";
import type {
  ToolActivityItem,
  ToolActivityState,
  ToolCallActivityItem,
} from "../components/ToolActivity.js";
import {
  FILE_WRITE_TOOL_NAMES,
  READ_TOOL_PATTERN,
  TOOL_PATH_KEYS,
  TOOL_URL_PATTERN,
  classifyFileChange,
  declaredFileChangePaths,
  extractPatchFileChanges,
  isGlobPattern,
  type FileChangeOperation,
} from "./tool-input-paths.js";
import { isRecord } from "../../../shared/is-record.js";

/**
 * How many pages a session's web list keeps that were merely MENTIONED by a
 * result — third-party links a search page quoted, not pages the turn asked
 * for. Pages named in a call's own arguments are never bounded: they are what
 * the conversation actually visited, and the list is meant to show all of
 * them. Exported because the chat preview model bounds its Browser tab by the
 * same rule: the tab and the activity lists are two views of one set of pages,
 * and a bound that lived on only one side would let a single link-heavy result
 * grow the other without limit.
 */
export const TOOL_ACTIVITY_MENTIONED_URL_LIMIT = 5;
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
 * from the same predicate — the tab and the activity lists show one set of
 * pages, so they must agree on which calls produce them.
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
  // has always excluded it; without the same guard here an activity row for
  // `src/**` can never resolve against the preview model.
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
 * the Browser tab and the activity lists different page lists for the same turn.
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
      out.push(...extractPatchFileChanges(child).map((change) => change.path));
    } else if (depth < 2) {
      out.push(...collectPathStrings(child, depth + 1));
    }
  }
  return out;
}

export interface FileChange {
  path: string;
  operation: FileChangeOperation;
  /** For a move: the other end — where the file came from, or went to. */
  counterpart?: string;
}

/**
 * The change a file-changing call made to each path it named. The call's
 * own name settles it for every builtin (`delete_file` deletes, `move_file`
 * moves, an edit modifies); a patch body settles it per header; a `write_file`
 * stays `write` because its output never says whether the path existed.
 * `move_file` names two paths — the one that stopped existing and the one that
 * started — so both are listed, each pointing at the other. Shared with the
 * chat preview model so the file tab and the activity lists label a change
 * the same way.
 */
export function collectFileChanges(tool: Pick<ToolEntryItem, "name" | "category" | "input">): FileChange[] {
  const operation = classifyFileChange(tool);
  if (!operation) return [];
  const declaredPaths = declaredFileChangePaths(tool.name, tool.input);
  if (declaredPaths !== undefined) {
    return [...new Set(declaredPaths)].map(path => ({ path, operation }));
  }
  if (operation === "move" && isRecord(tool.input)) {
    const [source] = collectPathStrings(tool.input.sourcePath);
    const [destination] = collectPathStrings(tool.input.destinationPath);
    if (source && destination) {
      return [
        { path: source, operation, counterpart: destination },
        { path: destination, operation, counterpart: source },
      ];
    }
  }
  const patch = isRecord(tool.input) && typeof tool.input.patch === "string" ? tool.input.patch : null;
  const patchOperations = new Map(
    (patch ? extractPatchFileChanges(patch) : []).map((change) => [change.path, change.operation] as const),
  );
  return [...new Set(collectPathStrings(tool.input))].map((path) => ({
    path,
    operation: patchOperations.get(path) ?? operation,
  }));
}

function addUniqueActivity(list: ToolActivityItem[], item: ToolActivityItem): void {
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
 * Where a transcript URL came from. `argument` means the turn asked for the
 * page by name — the URL was in the call's own input. `result` means a page
 * named it: third-party text.
 */
type TranscriptUrlOrigin = "argument" | "result";

export interface TranscriptUrl {
  url: string;
  /** The call the page is credited to — the only one that emits it. */
  toolUseId: string;
  origin: TranscriptUrlOrigin;
  status: ToolEntryItem["status"];
}

const URL_ORIGIN_RANK: Record<TranscriptUrlOrigin, number> = {
  result: 0,
  argument: 1,
};

/**
 * Which call owns each fetched page, and which pages make the list at all —
 * most recent first.
 *
 * A URL named in a call's ARGUMENTS outranks the same URL merely mentioned in a
 * result, so a page a `web_fetch` actually retrieved is credited to that fetch
 * and not to the `web_search` that happened to list it; at equal rank the
 * latest call wins, which is what puts a page revisited late in the session at
 * the top. Pages the turn asked for are all kept; pages a result merely
 * mentioned are bounded to the {@link TOOL_ACTIVITY_MENTIONED_URL_LIMIT} most
 * recent, so one link-heavy result (a search page quoting a hundred links) does
 * not become a hundred rows in a list meant to show what the conversation
 * actually visited. Shared by the activity lists and the chat preview model's
 * Browser tab so both show one set of pages.
 */
export function resolveTranscriptUrls(entries: ChatEntry[]): TranscriptUrl[] {
  const credited = new Map<string, TranscriptUrl & { producedAt: number }>();
  let producedAt = 0;

  for (const entry of entries) {
    if (entry.kind !== "tool_group") continue;
    for (const tool of entry.tools) {
      if (!isBrowserTool(tool)) continue;
      producedAt += 1;
      const argumentUrls = new Set(collectUrls(tool.input));
      for (const url of new Set([...argumentUrls, ...collectUrls(tool.result)])) {
        const origin: TranscriptUrlOrigin = argumentUrls.has(url) ? "argument" : "result";
        const existing = credited.get(url);
        if (existing && URL_ORIGIN_RANK[origin] < URL_ORIGIN_RANK[existing.origin]) {
          existing.producedAt = producedAt;
          continue;
        }
        credited.set(url, { url, toolUseId: tool.toolUseId, origin, status: tool.status, producedAt });
      }
    }
  }

  const newestFirst = [...credited.values()].sort((left, right) => right.producedAt - left.producedAt);
  let mentioned = 0;
  return newestFirst
    .filter((page) => page.origin === "argument" || ++mentioned <= TOOL_ACTIVITY_MENTIONED_URL_LIMIT)
    .map(({ producedAt: _producedAt, ...page }) => page);
}

/** The first path or URL a call named — what it acted on, in one string. */
function toolCallArgument(tool: ToolEntryItem): string | undefined {
  return collectUrls(tool.input)[0] ?? collectPathStrings(tool.input)[0];
}

/**
 * Derive the session's tool activity (read / changed files, plugin / MCP
 * calls, every tool call, fetched pages) from the current chat entries. Pure
 * — walks the entries newest-first and dedupes by activity key, so each list
 * reads most recent first. ChatView wraps it in a `useMemo`.
 */
export function computeToolActivity(entries: ChatEntry[]): ToolActivityState {
  const activity: ToolActivityState = {
    readFileCount: 0,
    changedFileCount: 0,
    mcpCallCount: 0,
    pluginCallCount: 0,
    toolCallCount: 0,
    fetchedPageCount: 0,
    readFiles: [],
    changedFiles: [],
    pluginCalls: [],
    mcpCalls: [],
    toolCalls: [],
    fetchedPages: [],
  };
  const readFileKeys = new Set<string>();
  const changedFileKeys = new Set<string>();

  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    if (entry.kind !== "tool_group") continue;

    for (let toolIndex = entry.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
      const tool = entry.tools[toolIndex];
      const source = formatToolSource(tool);
      const sourceDetail = source || (isTerminalTool(tool) ? "terminal" : isBrowserTool(tool) ? "web" : undefined);
      const argument = toolCallArgument(tool);

      activity.toolCallCount += 1;
      activity.toolCalls.push({
        id: `call:${tool.toolUseId}`,
        name: tool.name,
        status: tool.status,
        source: tool.source ?? "builtin",
        ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
        ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
        ...(tool.startedAt != null ? { startedAt: tool.startedAt } : {}),
        ...(tool.durationMs != null ? { durationMs: tool.durationMs } : {}),
        ...(argument ? { argument } : {}),
      } satisfies ToolCallActivityItem);

      if (isPluginTool(tool)) {
        activity.pluginCallCount += 1;
        addUniqueActivity(activity.pluginCalls, {
          id: `plugin:${tool.toolUseId}`,
          label: tool.name,
          detail: tool.pluginId ?? sourceDetail,
          status: tool.status,
        });
      }

      if (tool.source === "mcp" || tool.mcpServerId) {
        activity.mcpCallCount += 1;
        addUniqueActivity(activity.mcpCalls, {
          id: `mcp:${tool.toolUseId}`,
          label: tool.name,
          detail: tool.mcpServerId ?? sourceDetail,
          status: tool.status,
        });
      }

      if (isFileChangeTool(tool)) {
        for (const change of collectFileChanges(tool)) {
          if (!changedFileKeys.has(change.path)) {
            changedFileKeys.add(change.path);
            activity.changedFileCount += 1;
          }
          addUniqueActivity(activity.changedFiles, {
            id: `change:${tool.toolUseId}:${change.path}`,
            label: change.path,
            detail: change.counterpart ? `${tool.name} · ${change.counterpart}` : tool.name,
            target: change.path,
            status: tool.status,
            operation: change.operation,
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

  for (const page of resolveTranscriptUrls(entries)) {
    activity.fetchedPageCount += 1;
    activity.fetchedPages.push({
      id: `url:${page.toolUseId}:${page.url}`,
      label: formatUrlOrigin(page.url),
      detail: page.url,
      target: page.url,
      status: page.status,
    });
  }

  return activity;
}
