import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RenderHtmlPayload } from "../types.js";
import type { Attachment } from "../types/attachments.js";
import { extractFileEditDiff, type FileEditDiffData } from "../utils/file-diff.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import { getToolDisplayName } from "../utils/tool-display.js";

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
}

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

const PATH_KEYS = new Set([
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

const READ_TOOL_PATTERN = /(^|[._:-])(read|open|cat|grep|rg|search|find|list|glob)([._:-]|$)/i;
const WRITE_TOOL_NAMES = new Set(["edit_file", "apply_patch", "write_file"]);
const URL_PATTERN = /\bhttps?:\/\/[^\s"'<>]+/gi;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isLikelyPath(value: string): boolean {
  if (/^https?:\/\//i.test(value)) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || value.startsWith("~")) return true;
  return /[\\/]/.test(value) && /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function isToolResultStub(value: string): boolean {
  return value.startsWith("[tool_result stripped:") || value.startsWith("[tool_result truncated by host");
}

function trimPreviewText(value: string): string {
  if (value.length <= MAX_TEXT_PREVIEW_CHARS) return value;
  return `${value.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n\n[preview truncated: ${value.length - MAX_TEXT_PREVIEW_CHARS} chars hidden]`;
}

function collectUrls(value: unknown): string[] {
  const urls = new Set<string>();
  visitUnknown(value, (_key, item) => {
    if (typeof item !== "string") return;
    for (const match of item.matchAll(URL_PATTERN)) {
      urls.add(match[0]);
    }
  });
  return [...urls];
}

function collectPathStrings(value: unknown): string[] {
  const paths = new Set<string>();
  visitUnknown(value, (key, item) => {
    if (typeof item !== "string") return;
    if (key != null && PATH_KEYS.has(key.toLowerCase())) {
      if (isLikelyPath(item)) paths.add(item);
      return;
    }
    if (isLikelyPath(item)) paths.add(item);
  });
  return [...paths];
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
  if (WRITE_TOOL_NAMES.has(tool.name) || tool.category === "write") return "write";
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
        addOrMergeFile(files, {
          id: `tool:${path}`,
          path,
          label: basename(path),
          detail: compactDetail(path),
          sourceLabel: displayName,
          operation,
          previewTargetId: diff?.path === path ? `diff:${tool.toolUseId}:${path}` : undefined,
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

      for (const url of collectUrls(tool.input)) {
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
        }, targetIds);
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

      if (typeof tool.result === "string" && tool.result.length > 0) {
        const parsedJson = parseJson(tool.result);
        const hasRicherPreview =
          htmlPayload != null || diff != null || tool.uiPayload != null || searchHits.length > 0;
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
