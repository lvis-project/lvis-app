import { createElement, useEffect, useMemo, useState } from "react";
import type { WorkspaceTabKind } from "../preview/workspace-tabs.js";
import {
  Bot,
  Check,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Folder,
  Globe,
  Image,
  MessageSquare,
  Plug,
  Table,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { PreviewContent } from "../preview/preview-renderers.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";

export interface FileTreeNode {
  id: string;
  label: string;
  path: string;
  file?: WorkspaceFileItem;
  children: FileTreeNode[];
}
export const FILE_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["file", "diff", "image"]);
export const BROWSER_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["html", "url"]);
/** Pointer travel (px) that promotes a tab press into a horizontal pan. */
export const TAB_DRAG_THRESHOLD_PX = 6;

export function targetIcon(kind: ChatPreviewTarget["kind"]) {
  switch (kind) {
    case "image":
      return <Image className="h-3.5 w-3.5" />;
    case "html":
      return <Code2 className="h-3.5 w-3.5" />;
    case "diff":
      return <FileCode className="h-3.5 w-3.5" />;
    case "json":
      return <Table className="h-3.5 w-3.5" />;
    case "url":
      return <Globe className="h-3.5 w-3.5" />;
    case "plugin":
      return <Plug className="h-3.5 w-3.5" />;
    case "paste":
      return <FileText className="h-3.5 w-3.5" />;
    default:
      return <File className="h-3.5 w-3.5" />;
  }
}

export function tabIcon(kind: WorkspaceTabKind): LucideIcon {
  switch (kind) {
    case "file-browser":
      return Folder;
    case "browser":
      return Globe;
    case "terminal":
      return Terminal;
    case "preview":
      return Table;
    case "subagent":
      return Bot;
    case "side-chat":
      return MessageSquare;
  }
}

export function statusTone(status: ChatPreviewTarget["status"] | WorkspaceFileItem["status"]): string {
  if (status === "error") return "text-destructive";
  if (status === "running") return "text-warning";
  return "text-muted-foreground";
}

export function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
  if (!query) return true;
  const lower = query.toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(lower));
}

function pathSegments(path: string): string[] {
  return path.replace(/\\/g, "/").split("/").filter(Boolean);
}

function sortTree(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort((a, b) => {
    const aFolder = a.children.length > 0 && !a.file;
    const bFolder = b.children.length > 0 && !b.file;
    if (aFolder !== bFolder) return aFolder ? -1 : 1;
    return a.label.localeCompare(b.label);
  }).map((node) => {
    node.children = sortTree(node.children);
    return node;
  });
}

export function buildFileTree(files: WorkspaceFileItem[]): FileTreeNode[] {
  const root: FileTreeNode = { id: "root", label: "", path: "", children: [] };
  for (const file of files) {
    const segments = pathSegments(file.path);
    if (segments.length === 0) continue;
    let parent = root;
    let currentPath = "";
    for (const [index, segment] of segments.entries()) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let child = parent.children.find((candidate) => candidate.label === segment);
      if (!child) {
        child = { id: `${parent.id}/${segment}`, label: segment, path: currentPath, children: [] };
        parent.children.push(child);
      }
      if (index === segments.length - 1) child.file = file;
      parent = child;
    }
  }
  return sortTree(root.children);
}

export function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
  if (!query) return nodes;
  const filtered: FileTreeNode[] = [];
  for (const node of nodes) {
    const children = filterFileTree(node.children, query);
    const file = node.file;
    const selfMatches = matchesQuery(
      query,
      node.label,
      node.path,
      file?.label,
      file?.detail,
      file?.sourceLabel,
    );
    if (selfMatches || children.length > 0) {
      filtered.push({ ...node, children });
    }
  }
  return filtered;
}

function useCopyFlash() {
  const [copied, setCopied] = useState(false);
  return {
    copied,
    copy: (value: string) => {
      void navigator.clipboard?.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    },
  };
}

function TextBlock({ text }: { text: string }) {
  return (
    <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/(--opacity-muted) p-3 font-mono text-[11px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

export function DetailHeader({ target }: { target: ChatPreviewTarget }) {
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground">{targetIcon(target.kind)}</span>
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{target.title}</h3>
      </div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">{target.kind}</Badge>
        <span className="truncate">{target.subtitle ?? target.sourceLabel}</span>
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: string }) {
  return <div className="p-4 text-xs text-muted-foreground">{children}</div>;
}

function CopyButton({ value }: { value: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopyFlash();
  if (!value) return null;
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => copy(value)}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? t("chatPreviewRail.copied") : t("chatPreviewRail.copy")}</span>
    </Button>
  );
}

type PreviewReadError = NonNullable<Awaited<ReturnType<typeof window.lvis.preview.readFile>>["error"]>;

/** Map a preview-read error code to its Korean user message key. */
function fileErrorKey(code: PreviewReadError): string {
  switch (code) {
    case "path-not-allowed":
    case "sensitive-path":
      return "chatPreviewRail.fileErrorNotAllowed";
    case "binary-file":
      return "chatPreviewRail.fileErrorBinary";
    case "too-large":
      return "chatPreviewRail.fileErrorTooLarge";
    case "not-a-file":
      return "chatPreviewRail.fileErrorGlob";
    case "read-failed":
      return "chatPreviewRail.fileErrorNotFound";
    default:
      return "chatPreviewRail.fileErrorGeneric";
  }
}

/**
 * File preview body. Renders the file's CONTENT through the progressive
 * renderer registry (markdown/mermaid/text), loading it via the traversal-
 * guarded `window.lvis.preview.readFile` IPC when the target has no inline
 * text (diagnosis ①). Search-hit targets that already carry `inlineText`
 * render it directly without an IPC round-trip.
 */
function FilePreviewBody({ target }: { target: Extract<ChatPreviewTarget, { kind: "file" }> }) {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "loading" }
    | { phase: "ok"; content: string; path: string; truncated: boolean }
    | { phase: "error"; code: PreviewReadError }
  >({ phase: "idle" });

  useEffect(() => {
    // Inline text (e.g. an indexer search-hit snippet) needs no IPC read.
    if (target.inlineText) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    void window.lvis.preview
      .readFile(target.path)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setState({
            phase: "ok",
            content: result.content ?? "",
            path: result.path ?? target.path,
            truncated: Boolean(result.truncated),
          });
        } else {
          setState({ phase: "error", code: result.error ?? "read-failed" });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState({ phase: "error", code: "read-failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [target.path, target.inlineText]);

  const copyValue = target.inlineText
    ?? (state.phase === "ok" ? state.content : target.path);

  return (
    <div className="space-y-3" data-testid="chat-side-panel-file-preview">
      <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
        {target.path}
      </div>
      {target.inlineText ? (
        <PreviewContent descriptor={{ text: target.inlineText, path: target.path }} />
      ) : state.phase === "loading" ? (
        <div className="text-xs text-muted-foreground" data-testid="chat-side-panel-file-loading">
          {t("chatPreviewRail.filePreviewLoading")}
        </div>
      ) : state.phase === "ok" ? (
        <div className="space-y-2">
          {state.truncated ? (
            <Badge variant="outline" className="px-1 py-0 text-[10px]" data-testid="chat-side-panel-file-truncated">
              {t("chatPreviewRail.filePreviewTruncated")}
            </Badge>
          ) : null}
          <PreviewContent descriptor={{ text: state.content, path: state.path }} />
        </div>
      ) : state.phase === "error" ? (
        <div className="text-[11px] text-destructive" data-testid="chat-side-panel-file-error">
          {t(fileErrorKey(state.code))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {target.canOpenExternal ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void window.lvis.attach.openExternal(target.path)}>
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t("chatPreviewRail.openFile")}</span>
          </Button>
        ) : null}
        <CopyButton value={copyValue} />
      </div>
    </div>
  );
}

export function PreviewBody({
  api,
  sessionId,
  target,
}: {
  api: LvisApi;
  sessionId?: string;
  target: ChatPreviewTarget;
}) {
  const { t } = useTranslation();
  const [loadedStub, setLoadedStub] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    setLoadedStub(null);
    setLoadError(null);
    if (target.kind !== "tool-result" || !target.isStub || !sessionId || !target.toolUseId) return;
    let cancelled = false;
    void api.chatGetVerbatimToolResult(sessionId, target.toolUseId)
      .then((result) => {
        if (cancelled) return;
        setLoadedStub(result?.content ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, target]);

  const rawText = target.kind === "tool-result"
    ? loadedStub ?? target.raw
    : target.kind === "json"
      ? target.raw
      : target.kind === "paste"
        ? target.text
        : target.kind === "file" || target.kind === "image" || target.kind === "diff"
          ? target.path
          : target.kind === "url"
            ? target.url
            : target.kind === "plugin"
              ? target.resourceUri
              : target.kind === "html"
                ? target.payload.html
                : "";

  if (target.kind === "html") {
    return <BrowserDocumentViewer target={target} />;
  }

  if (target.kind === "diff") {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
          {target.path}
        </div>
        <FileEditDiff data={target.diff} />
        <CopyButton value={rawText} />
      </div>
    );
  }

  if (target.kind === "image") {
    return (
      <div className="space-y-3">
        <div className="overflow-hidden rounded-md border bg-muted/(--opacity-muted)">
          <img src={target.dataUrl} alt={target.title} className="max-h-[28rem] w-full object-contain" />
        </div>
        <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{target.path}</div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void window.lvis.attach.openExternal(target.path)}>
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t("chatPreviewRail.openFile")}</span>
          </Button>
          <CopyButton value={rawText} />
        </div>
      </div>
    );
  }

  if (target.kind === "file") {
    return <FilePreviewBody target={target} />;
  }

  if (target.kind === "url") {
    return <UrlDocumentViewer api={api} target={target} />;
  }

  if (target.kind === "plugin") {
    return (
      <div className="space-y-3 text-xs">
        <McpAppView payload={target.payload} />
        <dl className="space-y-2 rounded-md border bg-muted/(--opacity-muted) p-3">
          <div>
            <dt className="text-muted-foreground">{t("chatPreviewRail.server")}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{target.serverId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t("chatPreviewRail.resource")}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{target.resourceUri}</dd>
          </div>
          {target.slot ? (
            <div>
              <dt className="text-muted-foreground">{t("chatPreviewRail.slot")}</dt>
              <dd className="font-mono">{target.slot}</dd>
            </div>
          ) : null}
        </dl>
        {/* #885 b2 — detach is INLINE-only (Q5): a detached window's own
            McpAppView chrome must not offer a second, meaningless "detach". */}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="chat-side-panel-mcp-detach"
            // `sessionId` binds the detached card to the conversation it came from — the
            // detached window has no ChatContext to recover it, so without it main would
            // silently drop every `ui/message` / `ui/update-model-context` the card sends
            // (see shared/mcp-app-detached-payload.ts). The host supplies it; the app
            // never names a session.
            onClick={() => void window.lvis.mcp.openDetached(target.payload, { sessionId })}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t("chatPreviewRail.detach")}</span>
          </Button>
          <CopyButton value={rawText} />
        </div>
      </div>
    );
  }

  if (target.kind === "json") {
    return (
      <div className="space-y-3">
        <ToolPayloadBlock value={target.value} />
        <CopyButton value={rawText} />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {loadError ? <div className="text-xs text-destructive">{loadError}</div> : null}
      {target.kind === "tool-result" && target.isStub && loadedStub == null && !loadError ? (
        <div className="text-xs text-muted-foreground">{t("chatPreviewRail.loadingFullResult")}</div>
      ) : null}
      <PreviewContent descriptor={{ text: rawText, filename: target.title }} />
      <CopyButton value={rawText} />
    </div>
  );
}

export function BrowserDocumentViewer({ target }: { target: Extract<ChatPreviewTarget, { kind: "html" }> }) {
  const srcDoc = useMemo(
    () => wrapRenderHtmlInlineFrameDocument(target.payload.html, { allowScripts: true }),
    [target.payload.html],
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="chat-side-panel-browser-viewer">
      <div className="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/(--opacity-muted) px-3 text-[11px] text-muted-foreground">
        <Code2 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{target.payload.title ?? target.title}</span>
      </div>
      <iframe
        data-testid="chat-side-panel-browser-frame"
        title={target.payload.title ?? target.title}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="block min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}

export function UrlDocumentViewer({
  api,
  target,
  showHeader = true,
}: {
  api: LvisApi;
  target: Extract<ChatPreviewTarget, { kind: "url" }>;
  /**
   * Render the viewer's own URL/open-external header band. Default true. The
   * BrowserWorkspace tab passes false because the tab already owns a single
   * address bar above the webview — rendering the header here too produced the
   * duplicate-address-bar nesting (#11). This toggles ONLY the header <div>; the
   * webview node's key/position is invariant so the Electron guest is never
   * remounted when the flag changes.
   */
  showHeader?: boolean;
}) {
  const { t } = useTranslation();
  // Single URL-safety SOT (rejects non-http(s) + credential-laden urls). This is
  // the viewer boundary the url-safety header documents — it must not diverge
  // from the store / main-process checks, so it calls the shared validator
  // rather than re-implementing a weaker inline protocol-only check.
  const url = useMemo(() => normalizeBrowserNavigationUrl(target.url), [target.url]);

  if (!url) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="border-b bg-muted/(--opacity-muted) px-3 py-2 text-xs font-medium">{target.title}</div>
        <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
          <TextBlock text={target.url} />
          <CopyButton value={target.url} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background" data-testid="chat-side-panel-url-viewer">
      {showHeader ? (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b bg-muted/(--opacity-muted) px-2 text-[11px] text-muted-foreground">
          <Globe className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{url}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7 shrink-0"
                onClick={() => void api.openExternalUrl(url)}
                aria-label={t("chatPreviewRail.openUrl")}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("chatPreviewRail.openUrl")}</TooltipContent>
          </Tooltip>
        </div>
      ) : null}
      {createElement("webview", {
        "data-testid": "chat-side-panel-browser-webview",
        src: url,
        partition: LVIS_SIDE_BROWSER_PARTITION,
        webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
        className: "block min-h-0 w-full flex-1 border-0 bg-background",
        style: {
          display: "flex",
          width: "100%",
          height: "100%",
          border: 0,
          background: "transparent",
        },
      })}
    </div>
  );
}

export function FileTreeRows({
  nodes,
  depth = 0,
  selectedFileId,
  onSelectFile,
}: {
  nodes: FileTreeNode[];
  depth?: number;
  selectedFileId?: string;
  onSelectFile: (file: WorkspaceFileItem) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const isFile = Boolean(node.file);
        const active = isFile && node.file?.id === selectedFileId;
        return (
          <div key={node.id}>
            <button
              type="button"
              data-testid={isFile ? "chat-side-panel-file-tree-file" : "chat-side-panel-file-tree-folder"}
              className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-xs hover:bg-muted/(--opacity-muted) ${
                active ? "bg-accent text-accent-foreground" : ""
              }`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => {
                if (node.file) onSelectFile(node.file);
              }}
            >
              {isFile ? (
                <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate">{node.label}</span>
            </button>
            {node.children.length > 0 ? (
              <FileTreeRows nodes={node.children} depth={depth + 1} selectedFileId={selectedFileId} onSelectFile={onSelectFile} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function fileBasename(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
}

/**
 * Is `candidate` `root` itself or a descendant of it? Boundary-safe and
 * platform-agnostic: a bare `startsWith(root)` would let `/foo` falsely match
 * `/foobar`, so the character right after the prefix MUST be a path separator
 * (`/` or `\` — the renderer receives platform-native paths from main).
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root) && /[/\\]/.test(candidate.charAt(root.length));
}

/**
 * Relative path of `full` under `root` (renderer-side string math — no node:path
 * in the renderer). Falls back to the basename for the root itself and to the
 * absolute path when `full` is not a descendant of `root` (boundary-checked, so
 * `/foobar` is NOT treated as being under `/foo`).
 */
export function toRelativePath(root: string | null, full: string): string {
  if (!root) return full;
  if (full === root) return fileBasename(full);
  if (!isPathWithinRoot(root, full)) return full;
  return full.slice(root.length).replace(/^[/\\]+/, "") || full;
}

/**
 * Extension → row icon. `File` is the legitimate domain default for an unknown
 * extension (not a papering-over fallback).
 */
export function fileIcon(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  switch (ext) {
    case ".md":
    case ".txt":
    case ".rst":
      return FileText;
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".py":
    case ".go":
    case ".rs":
      return FileCode;
    case ".json":
    case ".yaml":
    case ".yml":
    case ".toml":
      return Code2;
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".svg":
    case ".webp":
      return Image;
    case ".csv":
    case ".tsv":
    case ".xlsx":
      return Table;
    case ".html":
    case ".htm":
      return Globe;
    case ".sh":
    case ".zsh":
    case ".bash":
      return Terminal;
    default:
      return File;
  }
}
