import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RenderHtmlPayload } from "../types.js";
import type { Attachment } from "../types/attachments.js";
import { extractFileEditDiff, type FileEditDiffData } from "../utils/file-diff.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import { getToolDisplayName } from "../utils/tool-display.js";
// The web-artifact vocabulary is shared with the action panel on purpose: the
// Browser tab and the Tool Activity list are two views of ONE set of fetched
// pages, so both sides must classify web tools and extract URLs with the same
// code. A second local collector here is what made the Browser tab read "no web
// artifacts" while the activity popup listed dozens of sources.
import {
  ACTION_PANEL_ACTIVITY_LIMIT,
  collectUrls,
  isBrowserTool,
} from "../utils/action-panel-activity.js";
import {
  FILE_WRITE_TOOL_NAMES,
  READ_TOOL_PATTERN,
  TOOL_PATH_KEYS,
  extractPatchPaths,
  isGlobPattern,
} from "../utils/tool-input-paths.js";
import { displaySafeLabel } from "../../../shared/display-safe-text.js";
import { MCP_RESOURCE_URI_MAX_CHARS } from "../../../shared/mcp-resource-bounds.js";
import { isRecord } from "../../../shared/is-record.js";

type ToolItem = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

export type ChatPreviewKind =
  | "file"
  | "image"
  | "paste"
  | "html"
  | "diff"
  | "json"
  | "tool-result"
  | "url"
  | "plugin";

export interface ChatPreviewTargetBase {
  id: string;
  kind: ChatPreviewKind;
  title: string;
  subtitle?: string;
  sourceLabel: string;
  createdOrder: number;
  toolUseId?: string;
  toolName?: string;
  status?: ToolItem["status"];
}

export interface FilePreviewTarget extends ChatPreviewTargetBase {
  kind: "file";
  path: string;
  canOpenExternal: boolean;
  /**
   * Inline document text carried with the target (e.g. a Local Indexer search
   * hit's snippet/rawText). When present the file preview renders this text
   * through the progressive renderer registry (markdown/mermaid by extension)
   * instead of showing only the path. Path-only targets omit it.
   */
  inlineText?: string;
}

export interface ImagePreviewTarget extends ChatPreviewTargetBase {
  kind: "image";
  path: string;
  dataUrl: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  canOpenExternal: boolean;
}

export interface PastePreviewTarget extends ChatPreviewTargetBase {
  kind: "paste";
  text: string;
  lines: number;
  chars: number;
}

export interface HtmlPreviewTarget extends ChatPreviewTargetBase {
  kind: "html";
  payload: RenderHtmlPayload;
}

export interface DiffPreviewTarget extends ChatPreviewTargetBase {
  kind: "diff";
  path: string;
  diff: FileEditDiffData;
}

export interface JsonPreviewTarget extends ChatPreviewTargetBase {
  kind: "json";
  value: unknown;
  raw: string;
}

export interface ToolResultPreviewTarget extends ChatPreviewTargetBase {
  kind: "tool-result";
  raw: string;
  isStub: boolean;
}

export interface UrlPreviewTarget extends ChatPreviewTargetBase {
  kind: "url";
  url: string;
  /**
   * Where the address came from.
   *
   * `argument` means the turn asked for this page by name — the URL was in the
   * call's own input. `result` means a page named it: third-party text that
   * became a one-click webview navigation the moment it was listed here. The
   * row says which, because those are not the same claim, and the viewer is
   * entitled to know before following one. (Both remain gated by
   * `normalizeBrowserNavigationUrl` at the open; this is disclosure, not a
   * second permission.)
   */
  origin: UrlTargetOrigin;
}

/**
 * `address` is the viewer's own: a URL typed into the browser tab's address
 * bar, or a browser tab they opened. It exists so those synthetic targets do
 * not have to claim one of the two transcript-derived provenances — a page the
 * user asked for by hand is neither an argument the model wrote nor a link some
 * result offered.
 */
type UrlTargetOrigin = "argument" | "result" | "address";

export interface PluginPreviewTarget extends ChatPreviewTargetBase {
  kind: "plugin";
  serverId: string;
  resourceUri: string;
  slot?: "chat" | "sidebar" | "tool-result";
  height?: number;
  payload: NonNullable<ToolItem["uiPayload"]>;
}

export type ChatPreviewTarget =
  | FilePreviewTarget
  | ImagePreviewTarget
  | PastePreviewTarget
  | HtmlPreviewTarget
  | DiffPreviewTarget
  | JsonPreviewTarget
  | ToolResultPreviewTarget
  | UrlPreviewTarget
  | PluginPreviewTarget;

export interface WorkspaceFileItem {
  id: string;
  path: string;
  label: string;
  detail: string;
  sourceLabel: string;
  operation: "attachment" | "read" | "write" | "tool";
  previewTargetId?: string;
  canOpenExternal: boolean;
  status?: ToolItem["status"];
}

export interface ChatPreviewModel {
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
}

const MAX_TEXT_PREVIEW_CHARS = 12_000;

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const last = normalized.split("/").filter(Boolean).pop();
  return last ?? path;
}

function compactDetail(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `${parts[0]}/.../${parts.slice(-2).join("/")}`;
}

function isLikelyPath(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")) return true;
  return /[\\/]/.test(value) && /\.[A-Za-z0-9]{1,12}$/.test(value);
}

/**
 * A bare filename-with-extension carrying NO directory separator
 * (`2026-07-03.md`) — the shape `write_file`/`read_file` produce when the model
 * writes into the working directory by name. `isLikelyPath` rejects it (its
 * generic clause demands a separator so free-text tokens like "index.ts" inside
 * a `content` blob don't leak in), so it is only accepted for values whose KEY
 * is a path key (see {@link collectPathStrings}). Whitespace disqualifies it —
 * a bare name is a single token, never a sentence. The glob guard runs first,
 * so `*.md` never reaches here.
 */
function isBareFilename(value: string): boolean {
  if (/\s/.test(value)) return false;
  return !/[\\/]/.test(value) && /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function isToolResultStub(value: string): boolean {
  return value.startsWith("[tool_result stripped:") || value.startsWith("[tool_result truncated by host");
}

function trimPreviewText(value: string): string {
  if (value.length <= MAX_TEXT_PREVIEW_CHARS) return value;
  return `${value.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n\n[preview truncated: ${value.length - MAX_TEXT_PREVIEW_CHARS} chars hidden]`;
}

function collectPathStrings(value: unknown): string[] {
  const paths = new Set<string>();
  visitUnknown(value, (key, item) => {
    if (typeof item !== "string") return;
    // An `apply_patch` body names the files it writes only inside the patch
    // text; the call's own arguments do not list them. Without this branch the
    // action panel emits those paths and this side does not, so the row's
    // lookup against `targets` misses and the open falls to the dead-end
    // file-browser branch.
    if (key != null && key.toLowerCase() === "patch") {
      for (const patched of extractPatchPaths(item)) paths.add(patched);
      return;
    }
    // Glob patterns are tool arguments, never files — never a file target.
    if (isGlobPattern(item)) return;
    if (key != null && TOOL_PATH_KEYS.has(key.toLowerCase())) {
      // A path-keyed value may be a bare working-dir filename (no separator);
      // accept it here where the key vouches for its role as a path.
      if (isLikelyPath(item) || isBareFilename(item)) paths.add(item);
      return;
    }
    if (isLikelyPath(item)) paths.add(item);
  });
  return [...paths];
}

/**
 * A URL named in a call's ARGUMENTS outranks the same URL merely mentioned in a
 * result. Mirrors {@link FILE_OPERATION_RANK}: the same artifact seen through a
 * stronger relationship keeps the stronger attribution, so a page a
 * `web_fetch` actually retrieved is credited to that fetch and not to the
 * `web_search` that happened to list it first.
 */
type TranscriptUrlOrigin = Exclude<UrlTargetOrigin, "address">;

const URL_ORIGIN_RANK: Record<TranscriptUrlOrigin, number> = {
  result: 0,
  argument: 1,
};

interface UrlAttribution {
  /** The call the target is credited to — the only one that emits it. */
  toolUseId: string;
  origin: TranscriptUrlOrigin;
}

/**
 * Which call owns each fetched page, and which pages make the list at all.
 *
 * Runs before the target walk because both answers need the whole transcript: a
 * later call can outrank an earlier one for the same URL, and the cap keeps the
 * MOST RECENT {@link ACTION_PANEL_ACTIVITY_LIMIT} pages — the same bound, and
 * the same end of the list, the action panel keeps. Without it one link-heavy
 * result (a search page quoting a hundred links) becomes a hundred rows in a
 * tab that is meant to show what this conversation actually visited.
 */
function resolveUrlAttributions(entries: ChatEntry[]): Map<string, UrlAttribution> {
  const attributions = new Map<string, UrlAttribution>();
  /** Position of the LAST call that produced each URL — what "most recent" means. */
  const lastProducedAt = new Map<string, number>();
  let producedAt = 0;

  for (const entry of entries) {
    if (entry.kind !== "tool_group") continue;
    for (const tool of entry.tools) {
      if (!isBrowserTool(tool)) continue;
      producedAt += 1;
      const argumentUrls = new Set(collectUrls(tool.input));
      for (const url of new Set([...argumentUrls, ...collectUrls(tool.result)])) {
        const origin: TranscriptUrlOrigin = argumentUrls.has(url) ? "argument" : "result";
        lastProducedAt.set(url, producedAt);
        const existing = attributions.get(url);
        if (existing && URL_ORIGIN_RANK[origin] <= URL_ORIGIN_RANK[existing.origin]) continue;
        attributions.set(url, { toolUseId: tool.toolUseId, origin });
      }
    }
  }

  if (attributions.size <= ACTION_PANEL_ACTIVITY_LIMIT) return attributions;
  const dropped = [...lastProducedAt]
    .sort((left, right) => right[1] - left[1])
    .slice(ACTION_PANEL_ACTIVITY_LIMIT);
  for (const [url] of dropped) attributions.delete(url);
  return attributions;
}

/**
 * Promote a glob/list tool's concrete result `matches[]` (string paths — see
 * `glob_files`/`list_files` result JSON in `file-tools.ts`) to openable file
 * paths. Symmetric with {@link extractSearchResultHits}: the pattern card
 * disappears, and the files the pattern actually found become openable.
 */
function extractGlobMatches(result: unknown): string[] {
  if (typeof result !== "string") return [];
  const parsed = parseJson(result);
  if (!isRecord(parsed)) return [];
  const rawMatches = parsed.matches;
  if (!Array.isArray(rawMatches)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rawMatches) {
    if (typeof item !== "string") continue;
    if (isGlobPattern(item) || !isLikelyPath(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function visitUnknown(value: unknown, visit: (key: string | null, item: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const item of value) visitUnknown(item, visit, key);
    return;
  }
  if (!isRecord(value)) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    visitUnknown(childValue, visit, childKey);
  }
}

/**
 * A search-result hit that carries an on-disk `path` to the source document
 * plus (optionally) an inline snippet. Shape-driven so the host stays plugin-
 * agnostic (§ "NO plugin-specific code in host"): any tool whose result JSON
 * has a `hits`/`results` array of `{ path, ... }` objects surfaces its hits as
 * openable file-preview targets (e.g. the Local Indexer's hybrid/vector search).
 */
interface SearchResultHit {
  path: string;
  docName?: string;
  page?: number;
  text?: string;
}

function extractSearchResultHits(result: unknown): SearchResultHit[] {
  if (typeof result !== "string") return [];
  const parsed = parseJson(result);
  if (!isRecord(parsed)) return [];
  const rawHits = parsed.hits ?? parsed.results;
  if (!Array.isArray(rawHits)) return [];
  const hits: SearchResultHit[] = [];
  for (const item of rawHits) {
    if (!isRecord(item)) continue;
    const path = item.path;
    if (typeof path !== "string" || !isLikelyPath(path)) continue;
    const hit: SearchResultHit = { path };
    if (typeof item.docName === "string") hit.docName = item.docName;
    if (typeof item.page === "number") hit.page = item.page;
    const text = typeof item.rawText === "string"
      ? item.rawText
      : typeof item.snippet === "string"
        ? item.snippet
        : undefined;
    if (text) hit.text = trimPreviewText(text);
    hits.push(hit);
  }
  return hits;
}

function parseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function toolSourceLabel(tool: ToolItem): string {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  if (tool.source === "builtin") return "builtin";
  return "tool";
}

function toolOperation(tool: ToolItem): WorkspaceFileItem["operation"] {
  if (FILE_WRITE_TOOL_NAMES.has(tool.name) || tool.category === "write") return "write";
  if (tool.category === "read" || READ_TOOL_PATTERN.test(tool.name)) return "read";
  return "tool";
}

function addUnique<T extends { id: string }>(items: T[], item: T, seen: Set<string>): void {
  if (seen.has(item.id)) return;
  seen.add(item.id);
  items.push(item);
}

const FILE_OPERATION_RANK: Record<WorkspaceFileItem["operation"], number> = {
  tool: 0,
  read: 1,
  attachment: 2,
  write: 3,
};

function addOrMergeFile(items: WorkspaceFileItem[], item: WorkspaceFileItem, seen: Set<string>): void {
  const existingIndex = items.findIndex((existing) => existing.id === item.id);
  if (existingIndex < 0) {
    seen.add(item.id);
    items.push(item);
    return;
  }
  const existing = items[existingIndex];
  const stronger = FILE_OPERATION_RANK[item.operation] >= FILE_OPERATION_RANK[existing.operation]
    ? item
    : existing;
  items[existingIndex] = {
    ...existing,
    ...item,
    sourceLabel: stronger.sourceLabel,
    operation: stronger.operation,
    previewTargetId: item.previewTargetId ?? existing.previewTargetId,
    canOpenExternal: existing.canOpenExternal || item.canOpenExternal,
  };
}

export function collectChatPreviewModel({
  entries,
  attachments,
}: {
  entries: ChatEntry[];
  attachments: Attachment[];
}): ChatPreviewModel {
  const targets: ChatPreviewTarget[] = [];
  const files: WorkspaceFileItem[] = [];
  const targetIds = new Set<string>();
  const fileIds = new Set<string>();
  // A fetched page is ONE artifact no matter how many calls surfaced it: a
  // search that returns a link and the fetch that follows it are the same
  // document. Decided up front — the winning call is the only one that emits
  // it below, and pages past the shared cap are absent from the map entirely.
  const urlAttributions = resolveUrlAttributions(entries);
  let order = 0;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      const targetId = `attachment:image:${attachment.id}`;
      addUnique(targets, {
        id: targetId,
        kind: "image",
        title: attachment.path ? basename(attachment.path) : `Image #${attachment.n}`,
        subtitle: `${attachment.width}x${attachment.height} · ${Math.round(attachment.bytes / 1024)} KB`,
        sourceLabel: "attachment",
        createdOrder: order++,
        path: attachment.path,
        dataUrl: attachment.dataUrl,
        mimeType: attachment.mimeType,
        bytes: attachment.bytes,
        width: attachment.width,
        height: attachment.height,
        canOpenExternal: true,
      }, targetIds);
      addOrMergeFile(files, {
        id: `attachment:${attachment.path}`,
        path: attachment.path,
        label: basename(attachment.path),
        detail: compactDetail(attachment.path),
        sourceLabel: "attachment",
        operation: "attachment",
        previewTargetId: targetId,
        canOpenExternal: true,
      }, fileIds);
    } else if (attachment.kind === "file") {
      const targetId = `attachment:file:${attachment.id}`;
      addUnique(targets, {
        id: targetId,
        kind: "file",
        title: attachment.name,
        subtitle: `${attachment.ext.toUpperCase()} · ${Math.round(attachment.bytes / 1024)} KB`,
        sourceLabel: "attachment",
        createdOrder: order++,
        path: attachment.path,
        canOpenExternal: true,
      }, targetIds);
      addOrMergeFile(files, {
        id: `attachment:${attachment.path}`,
        path: attachment.path,
        label: attachment.name,
        detail: compactDetail(attachment.path),
        sourceLabel: "attachment",
        operation: "attachment",
        previewTargetId: targetId,
        canOpenExternal: true,
      }, fileIds);
    } else if (attachment.kind === "resource") {
      // Preview shows the renderer-held fence VERBATIM, framing included. Main may
      // redact the provider-bound copy when the privacy setting is enabled, but
      // stripping framing here would preview a message the host never sends.
      addUnique(targets, {
        id: `attachment:resource:${attachment.id}`,
        // `kind` selects the preview renderer (plain text), it is NOT a provenance
        // label — this content is a server's, not the user's clipboard. The subtitle
        // carries the real provenance.
        kind: "paste",
        title: `Resource #${attachment.n}`,
        subtitle: `${attachment.serverId} · ${displaySafeLabel(attachment.uri, MCP_RESOURCE_URI_MAX_CHARS)}`,
        sourceLabel: "attachment",
        createdOrder: order++,
        text: trimPreviewText(attachment.text),
        lines: attachment.text.split("\n").length,
        chars: attachment.text.length,
      }, targetIds);
    } else {
      addUnique(targets, {
        id: `attachment:paste:${attachment.id}`,
        kind: "paste",
        title: `Paste #${attachment.n}`,
        subtitle: `${attachment.lines} lines · ${attachment.chars} chars`,
        sourceLabel: "attachment",
        createdOrder: order++,
        text: trimPreviewText(attachment.text),
        lines: attachment.lines,
        chars: attachment.chars,
      }, targetIds);
    }
  }

  for (const entry of entries) {
    if (entry.kind !== "tool_group") continue;
    for (const tool of [...entry.tools].sort((a, b) => a.displayOrder - b.displayOrder)) {
      const displayName = getToolDisplayName(tool.name);
      const sourceLabel = toolSourceLabel(tool);
      const operation = toolOperation(tool);
      const htmlPayload =
        tool.name === "render_html" && tool.status === "done"
          ? parseRenderHtmlResult(tool.result)
          : null;
      if (htmlPayload) {
        addUnique(targets, {
          id: `html:${tool.toolUseId}`,
          kind: "html",
          title: htmlPayload.title ?? displayName,
          subtitle: sourceLabel,
          sourceLabel,
          createdOrder: order++,
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          status: tool.status,
          payload: htmlPayload,
        }, targetIds);
      }

      const diff = extractFileEditDiff(tool);
      if (diff) {
        const targetId = `diff:${tool.toolUseId}:${diff.path}`;
        addUnique(targets, {
          id: targetId,
          kind: "diff",
          title: basename(diff.path),
          subtitle: `${displayName} · ${sourceLabel}`,
          sourceLabel,
          createdOrder: order++,
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          status: tool.status,
          path: diff.path,
          diff,
        }, targetIds);
        addOrMergeFile(files, {
          id: `tool:${diff.path}`,
          path: diff.path,
          label: basename(diff.path),
          detail: compactDetail(diff.path),
          sourceLabel: displayName,
          operation: "write",
          previewTargetId: targetId,
          canOpenExternal: false,
          status: tool.status,
        }, fileIds);
      }

      for (const path of collectPathStrings(tool.input)) {
        // Link the file-tree entry to the preview target it opens: a diff target
        // when this tool edited the path, else the plain `file:` target created
        // just below. Without this link a written/read file lists in the session
        // segment but clicking it opens nothing (no `previewTargetId` to resolve).
        const previewTargetId =
          diff?.path === path ? `diff:${tool.toolUseId}:${path}` : `file:${tool.toolUseId}:${path}`;
        addOrMergeFile(files, {
          id: `tool:${path}`,
          path,
          label: basename(path),
          detail: compactDetail(path),
          sourceLabel: displayName,
          operation,
          previewTargetId,
          canOpenExternal: false,
          status: tool.status,
        }, fileIds);
        if (!diff || diff.path !== path) {
          addUnique(targets, {
            id: `file:${tool.toolUseId}:${path}`,
            kind: "file",
            title: basename(path),
            subtitle: `${displayName} · ${sourceLabel}`,
            sourceLabel,
            createdOrder: order++,
            toolUseId: tool.toolUseId,
            toolName: tool.name,
            status: tool.status,
            path,
            canOpenExternal: false,
          }, targetIds);
        }
      }

      // A web tool's RESULT is where most fetched pages actually live — a
      // `web_search` names its hits nowhere else — so the result is read on the
      // same footing as the arguments. Restricted to web tools for the same
      // reason the action panel restricts it: a URL quoted inside a source file
      // a read tool returned is text, not a page this turn fetched. Accepted
      // consequence: a non-web tool carrying a url-shaped argument no longer
      // contributes a target. Nothing opened those addresses, and a row that
      // offers to navigate to one is a claim the transcript does not support.
      if (isBrowserTool(tool)) {
        for (const url of new Set([...collectUrls(tool.input), ...collectUrls(tool.result)])) {
          const attribution = urlAttributions.get(url);
          if (attribution?.toolUseId !== tool.toolUseId) continue;
          addUnique(targets, {
            id: `url:${tool.toolUseId}:${url}`,
            kind: "url",
            title: url.replace(/^https?:\/\//i, ""),
            subtitle: displayName,
            sourceLabel,
            createdOrder: order++,
            toolUseId: tool.toolUseId,
            toolName: tool.name,
            status: tool.status,
            url,
            origin: attribution.origin,
          }, targetIds);
        }
      }

      if (tool.status === "done" && tool.uiPayload) {
        addUnique(targets, {
          id: `plugin:${tool.toolUseId}:${tool.uiPayload.resourceUri}`,
          kind: "plugin",
          title: tool.uiPayload.title ?? displayName,
          subtitle: tool.uiPayload.resourceUri,
          sourceLabel: `mcp:${tool.uiPayload.serverId}`,
          createdOrder: order++,
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          status: tool.status,
          serverId: tool.uiPayload.serverId,
          resourceUri: tool.uiPayload.resourceUri,
          slot: tool.uiPayload.slot,
          height: tool.uiPayload.height,
          payload: tool.uiPayload,
        }, targetIds);
      }

      // Search-result hits (§6.10.8 부가-B): promote path-bearing hits to
      // file-preview targets carrying their inline snippet, so a hit opens the
      // source document in-preview instead of collapsing into one JSON card.
      const searchHits = extractSearchResultHits(tool.result);
      for (const hit of searchHits) {
        const targetId = `search-hit:${tool.toolUseId}:${hit.path}:${hit.page ?? ""}`;
        const subtitleParts = [hit.docName, hit.page != null ? `page ${hit.page}` : null]
          .filter((part): part is string => Boolean(part));
        addUnique(targets, {
          id: targetId,
          kind: "file",
          title: basename(hit.path),
          subtitle: subtitleParts.length > 0 ? subtitleParts.join(" · ") : `${displayName} · ${sourceLabel}`,
          sourceLabel,
          createdOrder: order++,
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          status: tool.status,
          path: hit.path,
          canOpenExternal: false,
          ...(hit.text ? { inlineText: hit.text } : {}),
        }, targetIds);
        addOrMergeFile(files, {
          id: `tool:${hit.path}`,
          path: hit.path,
          label: basename(hit.path),
          detail: compactDetail(hit.path),
          sourceLabel: displayName,
          operation: "read",
          previewTargetId: targetId,
          canOpenExternal: false,
          status: tool.status,
        }, fileIds);
      }

      // Glob/list result matches (diagnosis ③): the pattern itself is not a
      // file, but each concrete match IS — surface them as openable file
      // targets so a `glob_files`/`list_files` call yields a real file list
      // instead of a dead pattern placeholder.
      const globMatches = extractGlobMatches(tool.result);
      for (const matchPath of globMatches) {
        const targetId = `glob-match:${tool.toolUseId}:${matchPath}`;
        addUnique(targets, {
          id: targetId,
          kind: "file",
          title: basename(matchPath),
          subtitle: `${displayName} · ${sourceLabel}`,
          sourceLabel,
          createdOrder: order++,
          toolUseId: tool.toolUseId,
          toolName: tool.name,
          status: tool.status,
          path: matchPath,
          canOpenExternal: false,
        }, targetIds);
        addOrMergeFile(files, {
          id: `tool:${matchPath}`,
          path: matchPath,
          label: basename(matchPath),
          detail: compactDetail(matchPath),
          sourceLabel: displayName,
          operation: "read",
          previewTargetId: targetId,
          canOpenExternal: false,
          status: tool.status,
        }, fileIds);
      }

      if (typeof tool.result === "string" && tool.result.length > 0) {
        const parsedJson = parseJson(tool.result);
        const hasRicherPreview =
          htmlPayload != null || diff != null || tool.uiPayload != null || searchHits.length > 0 || globMatches.length > 0;
        if (parsedJson !== null && !hasRicherPreview) {
          addUnique(targets, {
            id: `json:${tool.toolUseId}`,
            kind: "json",
            title: displayName,
            subtitle: sourceLabel,
            sourceLabel,
            createdOrder: order++,
            toolUseId: tool.toolUseId,
            toolName: tool.name,
            status: tool.status,
            value: parsedJson,
            raw: trimPreviewText(tool.result),
          }, targetIds);
        } else if (!hasRicherPreview) {
          addUnique(targets, {
            id: `result:${tool.toolUseId}`,
            kind: "tool-result",
            title: displayName,
            subtitle: sourceLabel,
            sourceLabel,
            createdOrder: order++,
            toolUseId: tool.toolUseId,
            toolName: tool.name,
            status: tool.status,
            raw: trimPreviewText(tool.result),
            isStub: isToolResultStub(tool.result),
          }, targetIds);
        }
      }
    }
  }

  return { targets, files };
}
