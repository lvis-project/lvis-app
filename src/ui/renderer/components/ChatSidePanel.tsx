import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import { cn } from "../../../lib/utils.js";
import type { WorkspaceTab, WorkspaceTabKind, WorkspaceTabsStore } from "../preview/workspace-tabs.js";
import {
  WORKSPACE_TAB_LAUNCHER,
  matchesLauncherShortcut,
} from "./command-actions.js";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  Image,
  LayoutGrid,
  Loader2,
  MessageSquare,
  PanelRightClose,
  Pin,
  Plug,
  Plus,
  Search,
  Table,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Badge } from "../../../components/ui/badge.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../../../components/ui/context-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useTranslation } from "../../../i18n/react.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../shared/side-panel.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { formatIpcError } from "../format-ipc-error.js";
import { PreviewContent } from "../preview/preview-renderers.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";
import { PtyTerminalView } from "./PtyTerminalView.js";
import { VerticalSplitLayout } from "./VerticalSplitLayout.js";
import { useVerticalSplit } from "../hooks/use-vertical-split.js";
import { SubAgentCard, type SubAgentSpawn } from "./SubAgentCard.js";

interface FileTreeNode {
  id: string;
  label: string;
  path: string;
  file?: WorkspaceFileItem;
  children: FileTreeNode[];
}

const FILE_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["file", "diff", "image"]);
const BROWSER_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["html", "url"]);
/** Pointer travel (px) that promotes a tab press into a horizontal pan. */
const TAB_DRAG_THRESHOLD_PX = 6;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function targetIcon(kind: ChatPreviewTarget["kind"]) {
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

function tabIcon(kind: WorkspaceTabKind): LucideIcon {
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

function statusTone(status: ChatPreviewTarget["status"] | WorkspaceFileItem["status"]): string {
  if (status === "error") return "text-destructive";
  if (status === "running") return "text-warning";
  return "text-muted-foreground";
}

function matchesQuery(query: string, ...values: Array<string | undefined>): boolean {
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

function buildFileTree(files: WorkspaceFileItem[]): FileTreeNode[] {
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

function filterFileTree(nodes: FileTreeNode[], query: string): FileTreeNode[] {
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

function DetailHeader({ target }: { target: ChatPreviewTarget }) {
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

function EmptyState({ children }: { children: string }) {
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

function PreviewBody({
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
        <CopyButton value={rawText} />
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

function BrowserDocumentViewer({ target }: { target: Extract<ChatPreviewTarget, { kind: "html" }> }) {
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

function UrlDocumentViewer({
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

function FileTreeRows({
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

function fileBasename(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? path;
}

/**
 * Is `candidate` `root` itself or a descendant of it? Boundary-safe and
 * platform-agnostic: a bare `startsWith(root)` would let `/foo` falsely match
 * `/foobar`, so the character right after the prefix MUST be a path separator
 * (`/` or `\` — the renderer receives platform-native paths from main).
 */
function isPathWithinRoot(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root) && /[/\\]/.test(candidate.charAt(root.length));
}

/**
 * Relative path of `full` under `root` (renderer-side string math — no node:path
 * in the renderer). Falls back to the basename for the root itself and to the
 * absolute path when `full` is not a descendant of `root` (boundary-checked, so
 * `/foobar` is NOT treated as being under `/foo`).
 */
function toRelativePath(root: string | null, full: string): string {
  if (!root) return full;
  if (full === root) return fileBasename(full);
  if (!isPathWithinRoot(root, full)) return full;
  return full.slice(root.length).replace(/^[/\\]+/, "") || full;
}

/** Platform hint for the reveal label (Finder on macOS, Explorer elsewhere). */
const IS_MAC_LIKE =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/**
 * Extension → row icon. `File` is the legitimate domain default for an unknown
 * extension (not a papering-over fallback).
 */
function fileIcon(name: string): LucideIcon {
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

type WorkspaceDirEntry = { name: string; path: string; type: "file" | "directory" };

/**
 * Project-folder browser (diagnosis ③). Lists the persisted project roots
 * (default workspace + Settings `additionalDirectories`) and lets the user add
 * a new one via the native picker. Folders lazy-expand through
 * `window.lvis.workspace.listDir` (scope-revalidated in main); clicking a file
 * routes to `onOpenFile`, which loads its content via the same traversal-guarded
 * preview IPC used everywhere else.
 */
function ProjectRootsBrowser({
  onOpenFile,
  selectedPath,
}: {
  onOpenFile: (path: string) => void;
  selectedPath: string | null;
}) {
  const { t } = useTranslation();
  const [roots, setRoots] = useState<Array<{ path: string; isDefault: boolean }>>([]);
  const [activeRoot, setActiveRoot] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [childrenByPath, setChildrenByPath] = useState<Record<string, WorkspaceDirEntry[]>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // A path is "attempted" once loadDir resolves (success OR failure). The
  // auto-load effect keys off this so a dir whose listDir FAILED is not retried
  // forever: a failed listDir never populates childrenByPath, so without this the
  // effect would refire every render → an infinite render→IPC loop.
  const [attemptedPaths, setAttemptedPaths] = useState<Set<string>>(new Set());
  const [errorByPath, setErrorByPath] = useState<Record<string, string>>({});
  // Directories whose listing hit MAX_DIR_ENTRIES (main returns `truncated`), so
  // the browser can flag that only a prefix of the folder is shown.
  const [truncatedPaths, setTruncatedPaths] = useState<Set<string>>(new Set());
  // A picked folder whose adjacency warnings must be acknowledged before the
  // main process (workspace.pickRoot gate) will persist it into the read scope.
  // `ackToken` binds the confirmation to the exact dialog-picked path the main
  // process holds — the renderer echoes the token, never a path, so it can't
  // widen the read scope to a directory the native picker never returned.
  const [pendingWarning, setPendingWarning] = useState<
    { path: string; warnings: string[]; ackToken: string } | null
  >(null);
  // True while a folder drag hovers the roots panel — drives the drop-zone ring.
  const [dragOver, setDragOver] = useState(false);

  // Roving-tabindex active row (the single treeitem with tabIndex=0). Distinct
  // from `selectedPath` (the OPENED file, drives bg-accent) — this is keyboard
  // focus, not the opened file.
  const [activeItemPath, setActiveItemPath] = useState<string | null>(null);
  // path -> row element, for imperative focus moves (roving tabindex).
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Set true just before a keyboard-driven setActiveItemPath so the post-render
  // effect calls .focus(); prevents stealing focus on mount / mouse clicks.
  const pendingFocusRef = useRef(false);
  // Type-ahead buffer with a 500ms reset window.
  const typeaheadRef = useRef<{ buffer: string; timer: ReturnType<typeof setTimeout> | null }>({
    buffer: "",
    timer: null,
  });
  // Inline failure surface for the mutating ops (removeRoot / reveal). Cleared
  // when a new op starts or the user dismisses it — a failed op no longer
  // swallows its error result silently.
  const [opError, setOpError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const loadDir = useCallback(async (path: string) => {
    setLoadingPaths((prev) => new Set(prev).add(path));
    try {
      const res = await window.lvis.workspace.listDir(path);
      if (res.ok && res.entries) {
        setChildrenByPath((prev) => ({ ...prev, [path]: res.entries ?? [] }));
        setTruncatedPaths((prev) => {
          const has = prev.has(path);
          if (res.truncated && !has) return new Set(prev).add(path);
          if (!res.truncated && has) {
            const next = new Set(prev);
            next.delete(path);
            return next;
          }
          return prev;
        });
        setErrorByPath((prev) => {
          if (!(path in prev)) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      } else {
        // Surface the failure rather than swallowing it silently.
        setErrorByPath((prev) => ({ ...prev, [path]: res.error ?? "read-failed" }));
      }
    } catch {
      setErrorByPath((prev) => ({ ...prev, [path]: "read-failed" }));
    } finally {
      setAttemptedPaths((prev) => new Set(prev).add(path));
      setLoadingPaths((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const applyRoots = useCallback(
    (next: Array<{ path: string; isDefault: boolean }>, preferred?: string | null) => {
      setRoots(next);
      setActiveRoot((prev) => {
        const keep = preferred ?? prev;
        if (keep && next.some((r) => r.path === keep)) return keep;
        return next[0]?.path ?? null;
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    void window.lvis.workspace.listRoots().then((res) => {
      if (cancelled || !res.ok || !res.roots) return;
      applyRoots(res.roots);
    });
    return () => {
      cancelled = true;
    };
  }, [applyRoots]);

  useEffect(() => {
    if (
      activeRoot &&
      !childrenByPath[activeRoot] &&
      !loadingPaths.has(activeRoot) &&
      !attemptedPaths.has(activeRoot)
    ) {
      void loadDir(activeRoot);
    }
  }, [activeRoot, childrenByPath, loadingPaths, attemptedPaths, loadDir]);

  const toggleFolder = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // Manual expand is a user gesture (not a render loop): allow a retry of a
        // previously-failed folder by clearing its attempted mark before loading.
        if (!childrenByPath[path] && !loadingPaths.has(path)) {
          setAttemptedPaths((prevAttempted) => {
            if (!prevAttempted.has(path)) return prevAttempted;
            const nextAttempted = new Set(prevAttempted);
            nextAttempted.delete(path);
            return nextAttempted;
          });
          void loadDir(path);
        }
      }
      return next;
    });
  };

  // Flattened pre-order list of the CURRENTLY VISIBLE nodes (expanded subtrees
  // only). Rendering stays recursive; this memo backs keyboard navigation only.
  const flatNodes = useMemo<
    Array<{ path: string; name: string; isDir: boolean; depth: number; parentPath: string }>
  >(() => {
    if (!activeRoot) return [];
    const out: Array<{ path: string; name: string; isDir: boolean; depth: number; parentPath: string }> = [];
    const walk = (parentPath: string, depth: number) => {
      const siblings = childrenByPath[parentPath] ?? [];
      for (const entry of siblings) {
        const isDir = entry.type === "directory";
        out.push({ path: entry.path, name: entry.name, isDir, depth, parentPath });
        if (isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(activeRoot, 0);
    return out;
  }, [activeRoot, childrenByPath, expanded]);

  // Clamp the roving pointer when the tree changes (collapse / reload / switch).
  useEffect(() => {
    if (flatNodes.length === 0) {
      if (activeItemPath !== null) setActiveItemPath(null);
      return;
    }
    if (!activeItemPath || !flatNodes.some((n) => n.path === activeItemPath)) {
      setActiveItemPath(flatNodes[0].path);
    }
  }, [flatNodes, activeItemPath]);

  // Move DOM focus only for keyboard-driven changes (roving tabindex).
  useEffect(() => {
    if (!pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    if (activeItemPath) itemRefs.current.get(activeItemPath)?.focus();
  }, [activeItemPath]);

  // Clear the type-ahead timer on unmount.
  useEffect(
    () => () => {
      if (typeaheadRef.current.timer) clearTimeout(typeaheadRef.current.timer);
    },
    [],
  );

  const focusPath = useCallback((path: string | null) => {
    if (!path) return;
    pendingFocusRef.current = true;
    setActiveItemPath(path);
  }, []);

  const runTypeahead = (char: string, curIdx: number) => {
    const ta = typeaheadRef.current;
    if (ta.timer) clearTimeout(ta.timer);
    ta.buffer += char.toLowerCase();
    ta.timer = setTimeout(() => {
      ta.buffer = "";
      ta.timer = null;
    }, 500);
    const n = flatNodes.length;
    // Single-char buffer starts the search at the NEXT node (cycles repeats);
    // multi-char refines from the current node.
    const startOffset = ta.buffer.length === 1 ? 1 : 0;
    for (let i = 0; i < n; i++) {
      const cand = flatNodes[(curIdx + startOffset + i) % n];
      if (cand.name.toLowerCase().startsWith(ta.buffer)) {
        focusPath(cand.path);
        return;
      }
    }
  };

  const onTreeKeyDown = (e: ReactKeyboardEvent) => {
    if (flatNodes.length === 0) return;
    const idx = flatNodes.findIndex((n) => n.path === activeItemPath);
    const i = idx >= 0 ? idx : 0;
    const cur = flatNodes[i];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusPath(flatNodes[Math.min(i + 1, flatNodes.length - 1)].path);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusPath(flatNodes[Math.max(i - 1, 0)].path);
        break;
      case "ArrowRight":
        e.preventDefault();
        if (cur.isDir) {
          if (!expanded.has(cur.path)) {
            toggleFolder(cur.path); // collapsed -> expand (also lazy-loads)
          } else {
            const child = flatNodes[i + 1]; // expanded -> first child (if loaded)
            if (child && child.parentPath === cur.path) focusPath(child.path);
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (cur.isDir && expanded.has(cur.path)) {
          toggleFolder(cur.path); // expanded -> collapse
        } else if (cur.parentPath !== activeRoot) {
          focusPath(cur.parentPath); // else -> parent (activeRoot isn't a treeitem)
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (cur.isDir) toggleFolder(cur.path);
        else onOpenFile(cur.path);
        break;
      case "Home":
        e.preventDefault();
        focusPath(flatNodes[0].path);
        break;
      case "End":
        e.preventDefault();
        focusPath(flatNodes[flatNodes.length - 1].path);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          runTypeahead(e.key, i);
        }
    }
  };

  const addFolder = useCallback(async () => {
    const res = await window.lvis.workspace.pickRoot();
    if (!res.ok) return;
    if (res.requiresAcknowledgement && res.pendingPath && res.ackToken) {
      setPendingWarning({ path: res.pendingPath, warnings: res.warnings ?? [], ackToken: res.ackToken });
      return;
    }
    if (res.roots) applyRoots(res.roots, res.added ?? null);
  }, [applyRoots]);

  // ⌘O / Ctrl+O opens the folder picker when focus is within the panel (scoped —
  // no global shortcut pollution).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "o" || e.key === "O")) {
        const root = rootRef.current;
        if (root && root.contains(document.activeElement)) {
          e.preventDefault();
          void addFolder();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [addFolder]);

  // Surface a mutating-op IPC failure inline. `path-not-allowed` / `sensitive-path`
  // are the workspace-specific reveal codes absent from the shared IPC map, so
  // map them to the same "outside allowed folders" copy the file preview uses.
  const formatOpError = useCallback(
    (error: string | undefined, message: string | undefined) =>
      formatIpcError(error, message, {
        codeMap: {
          "path-not-allowed": t("chatPreviewRail.fileErrorNotAllowed"),
          "sensitive-path": t("chatPreviewRail.fileErrorNotAllowed"),
        },
      }),
    [t],
  );

  // Drag-drop add-root (#1458). A dropped folder path is renderer-NAMED — the
  // preload webUtils bridge turns the dropped File into a candidate path, which
  // main-side dropPrepare re-validates (Layer-0 hard-deny + is-a-directory)
  // before minting a MAIN-OWNED ack token. A drop ALWAYS routes through the same
  // acknowledgement panel the native warned-pick uses (the OS dialog never
  // vouched for the path, so the explicit user ack is that missing vouch), and
  // confirmPendingFolder echoes the token — never the path — to pickRoot. So the
  // drop can never widen the read scope without the user confirming.
  const handleFolderDrop = useCallback(
    async (files: FileList) => {
      setOpError(null);
      const paths = window.lvisDrop.resolveDroppedPaths(files);
      const dropped = paths[0]; // first dropped item only — no multi-add fan-out
      if (!dropped) return; // non-file drag (text/url) or unresolvable — no-op
      const res = await window.lvis.workspace.dropPrepare(dropped);
      if (!res.ok) {
        setOpError(formatOpError(res.error, undefined));
        return;
      }
      if (res.pendingPath && res.ackToken) {
        setPendingWarning({
          path: res.pendingPath,
          warnings: res.warnings ?? [],
          ackToken: res.ackToken,
        });
      }
    },
    [formatOpError],
  );

  // Reveal a file/folder in the OS file manager. Re-validated in main; surfaces
  // any failure inline instead of swallowing the result.
  const revealEntry = async (path: string) => {
    setOpError(null);
    const res = await window.lvis.workspace.reveal(path);
    if (!res.ok) setOpError(formatOpError(res.error, res.message));
  };

  const confirmPendingFolder = async () => {
    const pending = pendingWarning;
    if (!pending) return;
    // Second, explicit confirmation — echo the one-time token (never a path).
    // Main persists the token-bound dialog path and still hard-refuses a
    // sensitive/root path even when acknowledged.
    const res = await window.lvis.workspace.pickRoot({ ackToken: pending.ackToken });
    setPendingWarning(null);
    if (res.ok && res.roots) applyRoots(res.roots, res.added ?? null);
  };

  const activeRootIsDefault = Boolean(
    activeRoot && roots.find((r) => r.path === activeRoot)?.isDefault,
  );

  // Remove the active root from the read allow-list. Non-destructive (files are
  // untouched — only the Layer-1 read scope narrows); main refuses to remove the
  // default root or any path not already in `additionalDirectories`.
  const removeActiveRoot = async () => {
    if (!activeRoot || activeRootIsDefault) return;
    const removedRoot = activeRoot;
    setOpError(null);
    const res = await window.lvis.workspace.removeRoot(removedRoot);
    if (!res.ok) {
      setOpError(formatOpError(res.error, res.message));
      return;
    }
    if (!res.roots) return;
    // Drop cached children/expansion for the removed subtree so a re-add reloads.
    // Boundary-safe + cross-platform: `isPathWithinRoot` matches on a full
    // segment (so `/foo` won't purge `/foobar`) and both `/` and `\` separators.
    setChildrenByPath((prev) => {
      const next: Record<string, WorkspaceDirEntry[]> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (isPathWithinRoot(removedRoot, key)) continue;
        next[key] = value;
      }
      return next;
    });
    applyRoots(res.roots, res.roots[0]?.path ?? null);
  };

  // Re-list a folder whose previous listDir FAILED. A user gesture, so it clears
  // the attempted mark (the render-loop guard) before reloading.
  const retryDir = (path: string) => {
    setAttemptedPaths((prev) => {
      if (!prev.has(path)) return prev;
      const next = new Set(prev);
      next.delete(path);
      return next;
    });
    setErrorByPath((prev) => {
      if (!(path in prev)) return prev;
      const next = { ...prev };
      delete next[path];
      return next;
    });
    void loadDir(path);
  };

  const renderEntries = (path: string, depth: number): ReactElement => {
    const entries = childrenByPath[path] ?? [];
    const childPad = 8 + depth * 12;
    // Child-folder listing states (the active root's own loading/error is handled
    // one level up so the role=tree wrapper is always present).
    if (depth > 0 && loadingPaths.has(path) && entries.length === 0) {
      return (
        <div
          role="presentation"
          className="flex h-7 items-center gap-1 text-[11px] text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-child-loading"
        >
          {t("chatPreviewRail.filePreviewLoading")}
        </div>
      );
    }
    if (depth > 0 && errorByPath[path]) {
      return (
        <button
          type="button"
          className="flex h-7 w-full items-center gap-1 text-left text-[11px] text-destructive hover:underline"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-child-error"
          onClick={() => retryDir(path)}
        >
          {t("chatPreviewRail.dirLoadError")} · {t("common.retry")}
        </button>
      );
    }
    if (entries.length === 0 && attemptedPaths.has(path) && !loadingPaths.has(path) && !errorByPath[path]) {
      return (
        <div
          role="presentation"
          className="flex h-7 items-center text-[11px] italic text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-empty"
        >
          {t("chatPreviewRail.dirEmpty")}
        </div>
      );
    }
    return (
    <>
      {entries.map((entry, index) => {
        const isDir = entry.type === "directory";
        const isOpen = expanded.has(entry.path);
        const opened = !isDir && entry.path === selectedPath;
        const isActiveItem = entry.path === activeItemPath;
        return (
          <div key={entry.path}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div
                  ref={(el) => {
                    if (el) itemRefs.current.set(entry.path, el);
                    else itemRefs.current.delete(entry.path);
                  }}
                  role="treeitem"
                  aria-expanded={isDir ? isOpen : undefined}
                  // APG tree pattern: aria-selected reflects SELECTION (the
                  // opened file), not roving keyboard focus. Focus is carried
                  // separately by the roving tabindex below, so a screen reader
                  // announces the opened file — not merely the arrow-key cursor
                  // position — as "selected". Non-opened rows omit the attribute.
                  aria-selected={opened ? true : undefined}
                  aria-level={depth + 1}
                  aria-setsize={entries.length}
                  aria-posinset={index + 1}
                  tabIndex={isActiveItem ? 0 : -1}
                  data-testid={isDir ? "chat-side-panel-fs-folder" : "chat-side-panel-fs-file"}
                  className={`flex h-7 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md pr-2 text-left text-xs outline-none hover:bg-muted/(--opacity-muted) focus-visible:ring-1 focus-visible:ring-ring ${
                    opened ? "bg-accent text-accent-foreground" : ""
                  }`}
                  style={{ paddingLeft: 8 + depth * 12 }}
                  onClick={() => {
                    setActiveItemPath(entry.path);
                    if (isDir) toggleFolder(entry.path);
                    else onOpenFile(entry.path);
                  }}
                >
                  {isDir ? (
                    isOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    )
                  ) : (
                    createElement(fileIcon(entry.name), {
                      className: "h-3.5 w-3.5 shrink-0 text-muted-foreground",
                    })
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="min-w-[11rem]" data-testid="chat-side-panel-fs-context-menu">
                <ContextMenuItem
                  data-testid="chat-side-panel-fs-ctx-open"
                  onSelect={() => (isDir ? toggleFolder(entry.path) : onOpenFile(entry.path))}
                >
                  {isDir ? <Folder className="h-3.5 w-3.5" /> : <File className="h-3.5 w-3.5" />}
                  {t("chatPreviewRail.ctxOpen")}
                </ContextMenuItem>
                <ContextMenuItem
                  data-testid="chat-side-panel-fs-ctx-reveal"
                  onSelect={() => void revealEntry(entry.path)}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t(IS_MAC_LIKE ? "chatPreviewRail.revealInFinder" : "chatPreviewRail.revealInExplorer")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  data-testid="chat-side-panel-fs-ctx-copy-path"
                  onSelect={() => void navigator.clipboard?.writeText(entry.path)}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("chatPreviewRail.copyPath")}
                </ContextMenuItem>
                <ContextMenuItem
                  data-testid="chat-side-panel-fs-ctx-copy-rel"
                  onSelect={() => void navigator.clipboard?.writeText(toRelativePath(activeRoot, entry.path))}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("chatPreviewRail.copyRelativePath")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {isDir && isOpen ? <div role="group">{renderEntries(entry.path, depth + 1)}</div> : null}
          </div>
        );
      })}
      {truncatedPaths.has(path) ? (
        <div
          role="presentation"
          className="flex h-6 items-center text-[11px] italic text-muted-foreground"
          style={{ paddingLeft: childPad }}
          data-testid="chat-side-panel-fs-truncated"
        >
          {t("chatPreviewRail.dirTruncated")}
        </div>
      ) : null}
    </>
    );
  };

  return (
    // Drag-drop add-root (#1458): a dropped folder resolves to a renderer-named
    // candidate path (preload webUtils bridge) that main-side dropPrepare
    // hard-validates before an explicit ack — so it rides the #1448 ack tier
    // rather than regressing it. Add-root also stays on the native picker (the
    // FolderPlus button + ⌘/Ctrl+O), which the drop convenience sits on top of.
    <div
      ref={rootRef}
      className={cn(
        "space-y-1 rounded-md transition-colors",
        dragOver && "ring-2 ring-primary/(--opacity-half) bg-primary/(--opacity-faint)",
      )}
      data-testid="chat-side-panel-project-roots"
      onDragOver={(event) => {
        // preventDefault is required or the browser navigates to the file.
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(event) => {
        // Ignore leave events bubbling from children still inside the panel.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        void handleFolderDrop(event.dataTransfer.files);
      }}
    >
      <div className="flex items-center gap-1">
        {roots.length > 1 ? (
          <select
            aria-label={t("chatPreviewRail.rootSelectLabel")}
            data-testid="chat-side-panel-root-select"
            className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs"
            value={activeRoot ?? ""}
            onChange={(event) => setActiveRoot(event.target.value)}
          >
            {roots.map((root) => (
              <option key={root.path} value={root.path}>
                {fileBasename(root.path)}
                {root.isDefault ? ` · ${t("chatPreviewRail.rootDefaultBadge")}` : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
            {activeRoot ? fileBasename(activeRoot) : t("chatPreviewRail.projectRoots")}
          </span>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-add-root"
              aria-label={t("chatPreviewRail.addProjectRoot")}
              onClick={() => void addFolder()}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.addProjectRoot")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-collapse-all"
              aria-label={t("chatPreviewRail.collapseAll")}
              disabled={expanded.size === 0}
              onClick={() => setExpanded(new Set())}
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("chatPreviewRail.collapseAll")}</TooltipContent>
        </Tooltip>
        {activeRoot && !activeRootIsDefault ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                data-testid="chat-side-panel-remove-root"
                aria-label={t("chatPreviewRail.removeRoot")}
                onClick={() => void removeActiveRoot()}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("chatPreviewRail.removeRoot")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {opError ? (
        <div
          role="alert"
          data-testid="chat-side-panel-op-error"
          className="flex items-start gap-1 rounded-md border border-destructive bg-destructive/(--opacity-muted) px-2 py-1 text-[11px] text-destructive"
        >
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{opError}</span>
          <button
            type="button"
            className="shrink-0 rounded p-0.5 hover:bg-destructive/(--opacity-muted)"
            aria-label={t("common.close")}
            data-testid="chat-side-panel-op-error-dismiss"
            onClick={() => setOpError(null)}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : null}
      {pendingWarning ? (
        <div
          data-testid="chat-side-panel-root-warning"
          className="space-y-2 rounded-md border border-destructive bg-destructive/(--opacity-muted) p-2 text-[11px]"
        >
          <div className="font-medium text-destructive">{t("chatPreviewRail.rootWarningTitle")}</div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground [overflow-wrap:anywhere]">
            {pendingWarning.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              data-testid="chat-side-panel-root-warning-confirm"
              onClick={() => void confirmPendingFolder()}
            >
              {t("chatPreviewRail.rootWarningConfirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid="chat-side-panel-root-warning-cancel"
              onClick={() => setPendingWarning(null)}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {activeRoot ? (
        loadingPaths.has(activeRoot) && !childrenByPath[activeRoot] ? (
          <div className="px-2 py-1 text-[11px] text-muted-foreground">{t("chatPreviewRail.filePreviewLoading")}</div>
        ) : errorByPath[activeRoot] ? (
          <button
            type="button"
            className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] text-destructive hover:underline"
            data-testid="chat-side-panel-fs-error"
            onClick={() => retryDir(activeRoot)}
          >
            {t("chatPreviewRail.dirLoadError")} · {t("common.retry")}
          </button>
        ) : (
          <div role="tree" aria-label={t("chatPreviewRail.projectRoots")} onKeyDown={onTreeKeyDown}>
            {renderEntries(activeRoot, 0)}
          </div>
        )
      ) : (
        <div
          className="flex flex-col items-start gap-2 px-2 py-3 text-[11px] text-muted-foreground"
          data-testid="chat-side-panel-roots-empty"
        >
          <p>{t("chatPreviewRail.projectRootsEmpty")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void addFolder()}>
            <FolderPlus className="h-3.5 w-3.5" />
            {t("chatPreviewRail.addProjectRoot")}
          </Button>
        </div>
      )}
    </div>
  );
}

function FileBrowserWorkspace({
  api,
  sessionId,
  files,
  targetById,
  selectedId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  files: WorkspaceFileItem[];
  targetById: Map<string, ChatPreviewTarget>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitFilePercent");
  // A concrete filesystem file opened from the project-roots browser. Takes
  // precedence over the session-artifact selection in the detail pane.
  const [fsPath, setFsPath] = useState<string | null>(null);
  // Which source the TOP pane shows (R3): the project directory tree or this
  // chat's session artifacts. A segment toggle replaces the old vertical
  // stacking that squeezed the session list into a sliver. This is a SOURCE
  // switch on the horizontal axis — orthogonal to the top/bottom split axis
  // above, so the two never fight.
  const [fileSource, setFileSource] = useState<"directory" | "session">("directory");
  const sessionFileCount = files.length;
  const hasSessionFiles = sessionFileCount > 0;
  // The session segment is disabled with zero files; snap back to directory so a
  // previously-selected-but-now-empty session source can't strand an empty pane.
  const effectiveSource = fileSource === "session" && hasSessionFiles ? "session" : "directory";
  const tree = useMemo(() => filterFileTree(buildFileTree(files), query), [files, query]);
  const filteredFiles = useMemo(
    () => files.filter((file) => matchesQuery(query, file.label, file.detail, file.path, file.sourceLabel)),
    [files, query],
  );
  const selectedFile = useMemo(
    () => filteredFiles.find((file) => file.previewTargetId === selectedId) ?? filteredFiles[0] ?? null,
    [filteredFiles, selectedId],
  );
  const selectedFileTarget = selectedFile?.previewTargetId ? targetById.get(selectedFile.previewTargetId) ?? null : null;
  const hasFiles = filteredFiles.length > 0;
  const fsTarget = useMemo<Extract<ChatPreviewTarget, { kind: "file" }> | null>(() => {
    if (!fsPath) return null;
    return {
      id: `fs:${fsPath}`,
      kind: "file",
      title: fileBasename(fsPath),
      sourceLabel: "workspace",
      createdOrder: Number.MAX_SAFE_INTEGER,
      path: fsPath,
      // Not in the attach allow-list, so the OS "open" button would be denied —
      // keep it off; content still loads through the preview IPC.
      canOpenExternal: false,
    };
  }, [fsPath]);

  useEffect(() => {
    if (selectedFile?.previewTargetId && selectedFile.previewTargetId !== selectedId) {
      onSelect(selectedFile.previewTargetId);
    }
  }, [onSelect, selectedFile, selectedId]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-file-browser">
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizeFilePanels")}
        testId="chat-side-panel-file-split-layout"
        separatorTestId="chat-side-panel-file-splitter"
        top={
          <div className="flex min-h-0 flex-col" data-testid="chat-side-panel-file-tree">
            {/*
              R3 segment toggle: pick the top pane's source (project directory
              vs session artifacts) instead of stacking both. Only the chosen
              source occupies the whole pane, so the session list is no longer
              squeezed. The session segment is disabled when the chat has no
              artifacts yet.
            */}
            <div
              role="group"
              aria-label={t("chatPreviewRail.fileSourceLabel")}
              className="flex shrink-0 items-center gap-1 border-b p-1"
              data-testid="chat-side-panel-file-source-segment"
            >
              <button
                type="button"
                aria-pressed={effectiveSource === "directory"}
                data-testid="chat-side-panel-file-source-directory"
                className={cn(
                  "flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11px] font-medium",
                  effectiveSource === "directory"
                    ? "bg-primary/(--opacity-subtle) text-primary"
                    : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground",
                )}
                onClick={() => setFileSource("directory")}
              >
                <Folder className="h-3.5 w-3.5" aria-hidden="true" />
                {t("chatPreviewRail.fileSourceDirectory")}
              </button>
              <button
                type="button"
                aria-pressed={effectiveSource === "session"}
                disabled={!hasSessionFiles}
                data-testid="chat-side-panel-file-source-session"
                className={cn(
                  "flex h-7 flex-1 items-center justify-center gap-1 rounded-md text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-(--opacity-half)",
                  effectiveSource === "session"
                    ? "bg-primary/(--opacity-subtle) text-primary"
                    : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground",
                )}
                onClick={() => setFileSource("session")}
              >
                <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                {t("chatPreviewRail.fileSourceSession")}
                <Badge variant="outline" className="px-1 py-0 text-[10px]" data-testid="chat-side-panel-file-source-session-count">
                  {sessionFileCount}
                </Badge>
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {effectiveSource === "directory" ? (
                <ProjectRootsBrowser
                  selectedPath={fsPath}
                  onOpenFile={(path) => {
                    setFsPath(path);
                  }}
                />
              ) : hasFiles && tree.length > 0 ? (
                <FileTreeRows
                  nodes={tree}
                  selectedFileId={fsPath ? undefined : selectedFile?.id}
                  onSelectFile={(file) => {
                    setFsPath(null);
                    if (file.previewTargetId) onSelect(file.previewTargetId);
                  }}
                />
              ) : (
                <EmptyState>{t("chatPreviewRail.noFiles")}</EmptyState>
              )}
            </div>
          </div>
        }
        bottom={
          <div className="min-h-0 p-3">
            {fsTarget ? (
              <div className="space-y-3">
                <DetailHeader target={fsTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={fsTarget} />
              </div>
            ) : selectedFileTarget ? (
              <div className="space-y-3">
                <DetailHeader target={selectedFileTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={selectedFileTarget} />
              </div>
            ) : selectedFile ? (
              <div className="space-y-3">
                <div className="flex min-w-0 items-center gap-2">
                  <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{selectedFile.label}</h3>
                </div>
                <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
                  {selectedFile.path}
                </div>
                <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.pathOnlyHint")}</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{t("chatPreviewRail.emptyState")}</div>
            )}
          </div>
        }
      />
    </div>
  );
}

function PreviewWorkspace({
  api,
  sessionId,
  targets,
  selectedId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.toolName)),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  return (
    <ListDetailWorkspace
      api={api}
      sessionId={sessionId}
      query={query}
      setQuery={setQuery}
      placeholder={t("chatPreviewRail.searchPlaceholder")}
      rows={filteredTargets}
      selectedTarget={selectedTarget}
      emptyText={t("chatPreviewRail.noPreviewTargets")}
      rowTestId="chat-preview-target-row"
      onSelect={onSelect}
    />
  );
}

function BrowserWorkspace({
  api,
  tabId,
  targets,
  selectedId,
  onSelect,
  manualUrl,
  onManualUrlChange,
}: {
  api: LvisApi;
  tabId: string;
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  manualUrl: string | null;
  onManualUrlChange: (tabId: string, url: string | null) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [addressDraft, setAddressDraft] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.kind === "url" ? target.url : undefined)),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  useEffect(() => {
    setAddressDraft(manualUrl ?? (selectedTarget?.kind === "url" ? selectedTarget.url : ""));
    setAddressError(null);
  }, [manualUrl, selectedTarget, tabId]);

  const manualTarget = useMemo<Extract<ChatPreviewTarget, { kind: "url" }> | null>(() => {
    if (!manualUrl) return null;
    let title: string;
    try {
      title = new URL(manualUrl).hostname || manualUrl;
    } catch {
      title = manualUrl;
    }
    return {
      id: `manual-browser:${tabId}`,
      kind: "url",
      title,
      subtitle: t("chatPreviewRail.manualUrlSubtitle"),
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: manualUrl,
    };
  }, [manualUrl, t, tabId]);
  const displayedTarget = manualTarget ?? selectedTarget;

  const submitAddress = () => {
    const normalized = normalizeBrowserNavigationUrl(addressDraft);
    if (!normalized) {
      setAddressError(t("chatPreviewRail.browserInvalidUrl"));
      return;
    }
    setAddressDraft(normalized);
    setAddressError(null);
    onManualUrlChange(tabId, normalized);
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-browser-workspace">
      {/*
        Single address bar (#11): the browser tab owns ONE address row here and
        the viewer's own header is suppressed (UrlDocumentViewer showHeader=false)
        so there is no duplicate URL band nesting. The web-artifact list + search
        moved out of the always-on stacked strip into the floating 🔍 Popover.
      */}
      <form
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress();
        }}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <Input
          data-testid="chat-side-panel-browser-address"
          value={addressDraft}
          onChange={(event) => {
            setAddressDraft(event.target.value);
            if (addressError) setAddressError(null);
          }}
          placeholder={t("chatPreviewRail.browserAddressPlaceholder")}
          className="h-8 min-w-0 flex-1 text-xs"
        />
        <Popover open={searchOpen} onOpenChange={setSearchOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  aria-label={t("chatPreviewRail.browserSearch")}
                  data-testid="chat-side-panel-browser-search-trigger"
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t("chatPreviewRail.browserSearch")}</TooltipContent>
          </Tooltip>
          <PopoverContent
            align="end"
            className="w-72 p-0"
            data-testid="chat-side-panel-browser-search-popover"
          >
            <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
            <div className="max-h-64 overflow-auto p-2">
              {filteredTargets.length > 0 ? (
                <TargetRows
                  targets={filteredTargets}
                  selectedId={manualTarget ? undefined : selectedTarget?.id}
                  rowTestId="chat-side-panel-browser-row"
                  onSelect={(id) => {
                    onManualUrlChange(tabId, null);
                    onSelect(id);
                    setSearchOpen(false);
                  }}
                />
              ) : (
                <EmptyState>{t("chatPreviewRail.noBrowserTargets")}</EmptyState>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              className="h-8 w-8 shrink-0"
              aria-label={t("chatPreviewRail.browserGo")}
              data-testid="chat-side-panel-browser-go"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("chatPreviewRail.browserGo")}</TooltipContent>
        </Tooltip>
      </form>
      {addressError ? (
        <div className="shrink-0 border-b px-3 py-1.5 text-[11px] text-destructive" data-testid="chat-side-panel-browser-address-error">
          {addressError}
        </div>
      ) : null}
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {displayedTarget?.kind === "html" ? (
          <BrowserDocumentViewer target={displayedTarget} />
        ) : displayedTarget?.kind === "url" ? (
          <UrlDocumentViewer api={api} target={displayedTarget} showHeader={false} />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">{t("chatPreviewRail.noBrowserTargets")}</div>
        )}
      </div>
    </div>
  );
}

/** Status tone for the sub-agent list row badge. */
function subAgentStatusTone(status: SubAgentSpawn["status"]): string {
  if (status === "error") return "text-destructive";
  if (status === "done") return "text-muted-foreground";
  return "text-warning";
}

/**
 * One selectable row in the sub-agent list. Memoized so a live-updating spawn
 * (its turn count / status ticks as the agent runs) only re-renders its OWN row,
 * not every sibling — the list can hold many concurrent spawns.
 */
const SubAgentRow = memo(function SubAgentRow({
  spawn,
  active,
  onSelect,
}: {
  spawn: SubAgentSpawn;
  active: boolean;
  onSelect: (spawnId: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid="chat-side-panel-subagent-row"
      aria-selected={active}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted)",
        active ? "bg-accent text-accent-foreground" : "",
      )}
      onClick={() => onSelect(spawn.spawnId)}
    >
      {spawn.status === "running" ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" aria-hidden="true" />
      ) : (
        <Bot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium" title={spawn.title}>
        {spawn.title}
      </span>
      <span className={cn("shrink-0 text-[10px]", subAgentStatusTone(spawn.status))}>{spawn.status}</span>
    </button>
  );
});

/**
 * Sub-agent viewer tab (R4). Top pane = the list of this chat's sub-agent spawns
 * (live + completed); bottom pane = the SELECTED spawn's transcript/tool-activity
 * via the shared SubAgentCard. Only the selected spawn is rendered in detail (not
 * every card), and the list rows are memoized, so a chat that fanned out many
 * agents stays cheap. The top↕bottom split persists via sidePanelSplitSubagentPercent.
 */
function SubAgentViewer({
  api,
  subAgentSpawns,
}: {
  api: LvisApi;
  subAgentSpawns: SubAgentSpawn[];
}) {
  const { t } = useTranslation();
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitSubagentPercent");
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(null);
  // Running spawns first (the user usually wants the live one), then completed.
  const orderedSpawns = useMemo(() => {
    const running = subAgentSpawns.filter((spawn) => spawn.status === "running");
    const rest = subAgentSpawns.filter((spawn) => spawn.status !== "running");
    return [...running, ...rest];
  }, [subAgentSpawns]);
  const selectedSpawn = useMemo(
    () => orderedSpawns.find((spawn) => spawn.spawnId === selectedSpawnId) ?? orderedSpawns[0] ?? null,
    [orderedSpawns, selectedSpawnId],
  );

  if (orderedSpawns.length === 0) {
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center p-6 text-center" data-testid="chat-side-panel-subagent-empty">
        <Bot className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div className="mt-2 text-xs text-muted-foreground">{t("chatPreviewRail.subagentEmpty")}</div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-subagent-viewer">
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizeSubagentPanels")}
        testId="chat-side-panel-subagent-split-layout"
        separatorTestId="chat-side-panel-subagent-splitter"
        top={
          <div className="min-h-0 space-y-1 p-2" data-testid="chat-side-panel-subagent-list">
            {orderedSpawns.map((spawn) => (
              <SubAgentRow
                key={spawn.spawnId}
                spawn={spawn}
                active={spawn.spawnId === selectedSpawn?.spawnId}
                onSelect={setSelectedSpawnId}
              />
            ))}
          </div>
        }
        bottom={
          <div className="min-h-0 p-3" data-testid="chat-side-panel-subagent-detail">
            {selectedSpawn ? (
              <SubAgentCard spawn={selectedSpawn} />
            ) : (
              <div className="text-xs text-muted-foreground">{t("chatPreviewRail.subagentSelectHint")}</div>
            )}
          </div>
        }
      />
    </div>
  );
}

function SearchInput({
  query,
  setQuery,
  placeholder,
}: {
  query: string;
  setQuery: (query: string) => void;
  placeholder: string;
}) {
  return (
    <div className="shrink-0 border-b px-3 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="chat-preview-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={placeholder}
          className="h-8 w-full pl-7 text-xs"
        />
      </div>
    </div>
  );
}

function TargetRows({
  targets,
  selectedId,
  rowTestId,
  onSelect,
}: {
  targets: ChatPreviewTarget[];
  selectedId?: string;
  rowTestId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-1">
      {targets.map((target) => (
        <button
          key={target.id}
          type="button"
          data-testid={rowTestId}
          className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted) ${
            selectedId === target.id ? "bg-accent text-accent-foreground" : ""
          }`}
          onClick={() => onSelect(target.id)}
        >
          <span className="shrink-0 text-muted-foreground">{targetIcon(target.kind)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{target.title}</span>
            <span className="block truncate text-[10.5px] text-muted-foreground">{target.subtitle ?? target.sourceLabel}</span>
          </span>
          {target.status ? <span className={`shrink-0 text-[10px] ${statusTone(target.status)}`}>{target.status}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ListDetailWorkspace({
  api,
  sessionId,
  query,
  setQuery,
  placeholder,
  rows,
  selectedTarget,
  emptyText,
  rowTestId,
  onSelect,
}: {
  api: LvisApi;
  sessionId?: string;
  query: string;
  setQuery: (query: string) => void;
  placeholder: string;
  rows: ChatPreviewTarget[];
  selectedTarget: ChatPreviewTarget | null;
  emptyText: string;
  rowTestId: string;
  onSelect: (id: string) => void;
}) {
  const { topPercent, setTopPercent, commitTopPercent } = useVerticalSplit(api, "sidePanelSplitPreviewPercent");
  const { t } = useTranslation();
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <SearchInput query={query} setQuery={setQuery} placeholder={placeholder} />
      <VerticalSplitLayout
        topPercent={topPercent}
        onDragChange={setTopPercent}
        onCommit={commitTopPercent}
        ariaLabel={t("chatPreviewRail.resizePreviewPanels")}
        testId="chat-side-panel-preview-split-layout"
        separatorTestId="chat-side-panel-preview-splitter"
        top={
          <div className="min-h-0 p-2">
            {rows.length > 0 ? (
              <TargetRows targets={rows} selectedId={selectedTarget?.id} rowTestId={rowTestId} onSelect={onSelect} />
            ) : (
              <EmptyState>{emptyText}</EmptyState>
            )}
          </div>
        }
        bottom={
          <div className="min-h-0 p-3">
            {selectedTarget ? (
              <div className="space-y-3">
                <DetailHeader target={selectedTarget} />
                <PreviewBody api={api} sessionId={sessionId} target={selectedTarget} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{emptyText}</div>
            )}
          </div>
        }
      />
    </div>
  );
}

function tabLabelKey(kind: WorkspaceTabKind): string {
  switch (kind) {
    case "file-browser":
      return "chatPreviewRail.tab.fileBrowser";
    case "browser":
      return "chatPreviewRail.tab.browser";
    case "terminal":
      return "chatPreviewRail.tab.terminal";
    case "preview":
      return "chatPreviewRail.tab.preview";
    case "subagent":
      return "chatPreviewRail.tab.subagent";
    case "side-chat":
      return "chatPreviewRail.tab.sideChat";
  }
}

function tabTestId(kind: WorkspaceTabKind): string {
  switch (kind) {
    case "file-browser":
      return "chat-side-panel-tab-file-browser";
    case "browser":
      return "chat-side-panel-tab-browser";
    case "preview":
      return "chat-side-panel-tab-preview";
    case "terminal":
      return "chat-side-panel-tab-terminal";
    case "subagent":
      return "chat-side-panel-tab-subagent";
    case "side-chat":
      return "chat-side-panel-tab-side-chat";
  }
}

/**
 * Tab label: container tabs show `{kind} {ordinal}` (e.g. "Browser 2"); content
 * tabs show the item they point at (preview-target title, or the URL host).
 */
function tabLabel(
  tab: WorkspaceTab,
  targetById: Map<string, ChatPreviewTarget>,
  t: (key: string) => string,
): string {
  if (!tab.content) return `${t(tabLabelKey(tab.kind))} ${tab.ordinal}`;
  if (tab.content.source === "browser") {
    try {
      return new URL(tab.content.url).hostname || tab.content.url;
    } catch {
      return tab.content.url;
    }
  }
  return targetById.get(tab.content.targetId)?.title ?? t(tabLabelKey("preview"));
}

/**
 * Renders a CONTENT tab — a tab that points at one specific item. Browser
 * content reuses the sandboxed webview shell (`UrlDocumentViewer`); preview
 * content renders its target via the shared detail/body pair. Unlike container
 * tabs it does not carry the per-kind list — it shows exactly one thing.
 */
function ContentTabView({
  api,
  sessionId,
  tab,
  targetById,
}: {
  api: LvisApi;
  sessionId?: string;
  tab: WorkspaceTab;
  targetById: Map<string, ChatPreviewTarget>;
}) {
  const { t } = useTranslation();
  const content = tab.content;
  // Memoized synthetic url target for browser content tabs — rebuilding it every
  // render would remount the sandboxed webview on unrelated re-renders. The url
  // is already store-validated (normalizeContentRef) and re-validated by the
  // shared url-safety SOT inside UrlDocumentViewer; `new URL` here only derives
  // the display title, not a safety gate.
  const browserTarget = useMemo<Extract<ChatPreviewTarget, { kind: "url" }> | null>(() => {
    if (content?.source !== "browser") return null;
    let title: string;
    try {
      title = new URL(content.url).hostname || content.url;
    } catch {
      title = content.url;
    }
    return {
      id: `content-browser:${tab.id}`,
      kind: "url",
      title,
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: content.url,
    };
  }, [content, tab.id, t]);
  if (!content) return null;
  if (browserTarget) {
    return <UrlDocumentViewer api={api} target={browserTarget} />;
  }
  const target = content.source === "preview" ? targetById.get(content.targetId) : undefined;
  if (!target) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="chat-side-panel-content-unavailable" data-tab-id={tab.id}>
        {t("chatPreviewRail.contentUnavailable")}
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-auto p-3" data-testid="chat-side-panel-content-view" data-tab-id={tab.id}>
      <div className="space-y-3">
        <DetailHeader target={target} />
        <PreviewBody api={api} sessionId={sessionId} target={target} />
      </div>
    </div>
  );
}

/**
 * The launcher item list (§6.10.3), rendered from the single SOT
 * `WORKSPACE_TAB_LAUNCHER` in `command-actions.ts`. It is used in TWO places —
 * the empty-state picker (`WorkspaceLauncher`) and the tab-bar "+" dropdown
 * (`WorkspaceLauncherMenu`) — so both surfaces share one list and one set of
 * shortcuts. `renderItem` lets each surface wrap a row in its own element
 * (a plain `button` for the inline list, a `DropdownMenuItem` for the menu).
 *
 * `사이드채팅` (side chat) is a planned launcher item but is DEFERRED — it is not
 * in `WORKSPACE_TAB_LAUNCHER` and no functional entry is added here.
 */
function LauncherItems({
  onOpen,
  renderItem,
}: {
  onOpen: (kind: WorkspaceTabKind) => void;
  renderItem: (item: (typeof WORKSPACE_TAB_LAUNCHER)[number], children: ReactElement, onSelect: () => void) => ReactElement;
}) {
  const { t } = useTranslation();
  return (
    <>
      {WORKSPACE_TAB_LAUNCHER.map((item) => {
        const Icon = item.icon;
        const label = t(item.labelKey);
        const row = (
          <>
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {item.shortcutHint ? (
              <kbd className="shrink-0 rounded bg-muted/(--opacity-muted) px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                {item.shortcutHint}
              </kbd>
            ) : null}
          </>
        );
        return renderItem(item, row, () => onOpen(item.kind));
      })}
    </>
  );
}

/**
 * Empty-state launcher (§6.10.3). Renders when the workspace has no tabs — a
 * vertical, centered picker of the openable content kinds. Shares the item list
 * with the tab-bar "+" dropdown via `LauncherItems`.
 */
function WorkspaceLauncher({ onOpen }: { onOpen: (kind: WorkspaceTabKind) => void }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col items-center justify-center overflow-auto p-6"
      data-testid="chat-side-panel-launcher"
    >
      <div className="w-full max-w-xs space-y-3">
        <div className="flex flex-col items-center gap-1 text-center">
          <LayoutGrid className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <div className="text-sm font-semibold">{t("chatPreviewRail.launcher.title")}</div>
          <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.launcher.subtitle")}</div>
        </div>
        <div className="space-y-1" role="menu" aria-label={t("chatPreviewRail.launcher.title")}>
          <LauncherItems
            onOpen={onOpen}
            renderItem={(item, children, onSelect) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                data-testid={`chat-side-panel-launcher-${item.kind}`}
                className="flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm hover:bg-muted/(--opacity-muted)"
                onClick={onSelect}
              >
                {children}
              </button>
            )}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Tab-bar "+" button — opens the same launcher as a dropdown menu. Replaces the
 * old scattered per-kind add-tab buttons; the SOT list drives both this and the
 * empty-state picker.
 */
function WorkspaceLauncherMenu({ onOpen }: { onOpen: (kind: WorkspaceTabKind) => void }) {
  const { t } = useTranslation();
  const label = t("chatPreviewRail.launcher.addTab");
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              data-testid="chat-side-panel-add-tab"
              aria-label={label}
              title={label}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-52" data-testid="chat-side-panel-launcher-menu">
        <LauncherItems
          onOpen={onOpen}
          renderItem={(item, children, onSelect) => (
            <DropdownMenuItem
              key={item.kind}
              data-testid={`chat-side-panel-launcher-menu-${item.kind}`}
              className="flex items-center gap-3"
              onSelect={onSelect}
            >
              {children}
            </DropdownMenuItem>
          )}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface ChatSidePanelProps {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  /**
   * Workspace-tab store, lifted out of this component (see
   * `preview/workspace-tabs.ts`). ChatSidePanel is unmounted whenever the rail
   * closes / the view leaves home / the session switches; owning tab state here
   * would destroy it on every such transition. The store lives at ChatView
   * level so tab state survives.
   */
  workspaceTabs: WorkspaceTabsStore;
  /**
   * This chat's sub-agent spawns (live + completed), sourced from ChatView's
   * spawn stream. Drives the subagent viewer tab (R4). Prop-drilled rather than
   * re-subscribed here so there is one spawn source of truth.
   */
  subAgentSpawns: SubAgentSpawn[];
  /** Docked panel width (px), owned by ChatView (useSidePanelWidth). */
  width: number;
  /** Drag-live width update — state only, no persist. */
  onWidthChange: (px: number) => void;
  /** Persist width (drag-end / keyboard step). */
  onWidthCommit: (px: number) => void;
  /**
   * Docked variant applies the persisted width + drag handle. The narrow-screen
   * drawer variant sets this false: the sheet controls width (w-full), so the
   * inline width and left splitter are dropped.
   */
  resizable?: boolean;
  className?: string;
}

export function ChatSidePanel({
  api,
  sessionId,
  targets,
  files,
  selectedId,
  onSelect,
  onClose,
  workspaceTabs,
  subAgentSpawns,
  width,
  onWidthChange,
  onWidthCommit,
  resizable = true,
  className = "",
}: ChatSidePanelProps) {
  const { t } = useTranslation();
  const asideRef = useRef<HTMLElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  // Latest width, read by the drag-end cleanup closure (non-reactive) so the
  // persisted value is exact.
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);
  // Release any in-flight pointer capture on unmount (mirrors the file-tree
  // splitter cleanup) so a drag crossing an unmount boundary leaks no listeners.
  useEffect(() => () => resizeCleanupRef.current?.(), []);

  // ─── Tab-bar horizontal scroll / drag-pan (diagnosis ②) ──────────────────
  const tabScrollElRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  // dragging = pointer is down and tracked; moved = pan threshold crossed (so
  // the trailing click is swallowed instead of selecting/closing a tab).
  const tabDragRef = useRef({ dragging: false, startX: 0, startScroll: 0, moved: false });
  useEffect(() => () => wheelCleanupRef.current?.(), []);

  // Wheel (vertical → horizontal) + overflow tracking. Bound as a NON-passive
  // native listener via a callback ref: React's onWheel is passive, so its
  // preventDefault() is ignored (and the tab strip is conditionally rendered,
  // so useEffect([]) would miss the mount). ResizeObserver keeps overflow live.
  const attachTabScroll = useCallback((node: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    tabScrollElRef.current = node;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      if (node.scrollWidth <= node.clientWidth) return; // no overflow → let it be
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      node.scrollLeft += delta;
      event.preventDefault(); // suppress ancestor vertical scroll / history back
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    wheelCleanupRef.current = () => node.removeEventListener("wheel", onWheel);
  }, []);

  const onTabPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Mouse-only: touch already gets native `overflow-x-auto` panning; a second
    // handler would double-scroll. Right/middle buttons never start a pan.
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const el = tabScrollElRef.current;
    if (!el) return;
    tabDragRef.current = { dragging: true, startX: event.clientX, startScroll: el.scrollLeft, moved: false };
  };
  const onTabPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const st = tabDragRef.current;
    const el = tabScrollElRef.current;
    if (!st.dragging || !el) return;
    const dx = event.clientX - st.startX;
    if (!st.moved && Math.abs(dx) > TAB_DRAG_THRESHOLD_PX) {
      st.moved = true;
      el.setPointerCapture?.(event.pointerId);
      el.dataset.dragging = "true"; // cursor: grabbing, no re-render
    }
    if (st.moved) el.scrollLeft = st.startScroll - dx;
  };
  const onTabPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const st = tabDragRef.current;
    const el = tabScrollElRef.current;
    if (st.moved && el) {
      el.releasePointerCapture?.(event.pointerId);
      delete el.dataset.dragging;
    }
    st.dragging = false; // st.moved kept so onClickCapture can swallow the click
  };
  const onTabClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (tabDragRef.current.moved) {
      event.preventDefault();
      event.stopPropagation();
      tabDragRef.current.moved = false;
    }
  };

  // Compute the clamped docked width for a pointer x, or null if the panel is
  // not mounted. Pure — it never touches React state (see the drag handler).
  const widthForClientX = (clientX: number): number | null => {
    const el = asideRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    // 12rem viewport margin == the max-w-[calc(100vw-12rem)] safety cap.
    const max = Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - 192);
    // Panel is right-docked: the right edge is fixed, dragging the left edge
    // leftwards widens it.
    return clampNumber(Math.round(rect.right - clientX), SIDE_PANEL_MIN_WIDTH, max);
  };
  const {
    tabs,
    activeTabId,
    browserUrlByTab,
    setActiveTabId,
    addTab,
    promoteToPinned,
    closeTab,
    setBrowserTabUrl,
  } = workspaceTabs;

  // #1444: closing a terminal tab must also kill its live PTY in the main
  // process (the store only drops the tab record). Non-terminal tabs are
  // unaffected.
  const closeWorkspaceTab = useCallback(
    (id: string) => {
      const closing = tabs.find((tab) => tab.id === id);
      if (closing?.kind === "terminal") void api.terminal?.kill(id);
      closeTab(id);
    },
    [tabs, api, closeTab],
  );

  const targetById = useMemo(
    () => new Map(targets.map((target) => [target.id, target])),
    [targets],
  );
  const browserTargets = useMemo(
    () => targets.filter((target) => BROWSER_TARGET_KINDS.has(target.kind)),
    [targets],
  );
  // #1444: the terminal tab is now a REAL interactive PTY, so the read-only
  // tool-shell command outputs (formerly filtered into the old TerminalWorkspace)
  // are folded into the review/preview tab — nothing is lost, and the terminal
  // tab hosts a live shell instead.
  const previewTargets = useMemo(
    () => targets.filter((target) => !FILE_TARGET_KINDS.has(target.kind) && !BROWSER_TARGET_KINDS.has(target.kind)),
    [targets],
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;

  // Panel-scoped launcher shortcuts (§6.10.3). Bound only while the panel is
  // mounted so ⌘T/⌘P/⌃⇧G reach the workspace rail without stealing app-wide
  // keys (none of these three are bound elsewhere — verified). Ignored when a
  // text input/textarea/contenteditable is focused so typing is not hijacked.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement | null;
      if (activeElement) {
        const tag = activeElement.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || activeElement.isContentEditable) return;
      }
      for (const item of WORKSPACE_TAB_LAUNCHER) {
        if (item.shortcut && matchesLauncherShortcut(item.shortcut, event)) {
          event.preventDefault();
          addTab(item.kind);
          return;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [addTab]);

  // Keep the active tab in view when it changes / the strip resizes. Uses
  // getBoundingClientRect + manual scrollLeft (not scrollIntoView) so it never
  // nudges the ancestor vertical scroll.
  useEffect(() => {
    const el = tabScrollElRef.current;
    if (!el || !activeTab) return;
    const tabEl = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(activeTab.id)}"]`);
    if (!tabEl) return;
    const c = el.getBoundingClientRect();
    const r = tabEl.getBoundingClientRect();
    if (r.left < c.left) el.scrollLeft -= (c.left - r.left) + 8;
    else if (r.right > c.right) el.scrollLeft += (r.right - c.right) + 8;
  }, [activeTab, tabs.length]);

  return (
    <aside
      ref={asideRef}
      data-testid="chat-side-panel"
      style={resizable ? { width: `${width}px` } : undefined}
      className={`min-h-0 min-w-0 border-l border-border/(--opacity-strong) bg-background/(--opacity-solid) backdrop-blur ${className}`}
    >
      {resizable ? (
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chatPreviewRail.resizePanel")}
        aria-valuenow={Math.round(width)}
        aria-valuemin={SIDE_PANEL_MIN_WIDTH}
        aria-valuemax={Math.round(Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - 192))}
        tabIndex={0}
        data-testid="chat-side-panel-width-splitter"
        className="group absolute inset-y-0 left-0 z-50 flex w-2 -translate-x-1/2 cursor-col-resize touch-none select-none items-center justify-center outline-none"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          resizeCleanupRef.current?.();
          const el = asideRef.current;
          let raf = 0;
          // A drag applies width straight to the panel DOM (coalesced via rAF)
          // and records it in widthRef — NOT React state — so a pointermove does
          // not re-render the whole ChatView tree every frame. The final width is
          // pushed to React state + persisted once on release.
          const apply = (clientX: number) => {
            const next = widthForClientX(clientX);
            if (next == null) return;
            widthRef.current = next;
            if (raf) return;
            raf = requestAnimationFrame(() => {
              raf = 0;
              if (el) el.style.width = `${widthRef.current}px`;
            });
          };
          apply(event.clientX);
          const onMove = (moveEvent: PointerEvent) => apply(moveEvent.clientX);
          const cleanup = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
            if (raf) cancelAnimationFrame(raf);
            resizeCleanupRef.current = null;
            onWidthChange(widthRef.current);
            onWidthCommit(widthRef.current);
          };
          resizeCleanupRef.current = cleanup;
          window.addEventListener("pointermove", onMove);
          window.addEventListener("pointerup", cleanup);
          window.addEventListener("pointercancel", cleanup);
        }}
        onKeyDown={(event) => {
          const max = Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - 192);
          const STEP = 16;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            const v = clampNumber(width + STEP, SIDE_PANEL_MIN_WIDTH, max);
            onWidthChange(v);
            onWidthCommit(v);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            const v = clampNumber(width - STEP, SIDE_PANEL_MIN_WIDTH, max);
            onWidthChange(v);
            onWidthCommit(v);
          } else if (event.key === "Home") {
            event.preventDefault();
            onWidthChange(SIDE_PANEL_MIN_WIDTH);
            onWidthCommit(SIDE_PANEL_MIN_WIDTH);
          } else if (event.key === "End") {
            event.preventDefault();
            onWidthChange(max);
            onWidthCommit(max);
          }
        }}
      >
        <span className="h-full w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
      </div>
      ) : null}
      <div data-testid="chat-preview-rail" className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <PanelRightClose className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{t("chatPreviewRail.title")}</div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="icon-xs" variant="ghost" title={t("chatPreviewRail.close")} aria-label={t("chatPreviewRail.close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {tabs.length > 0 ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-2 py-1">
          <div
            ref={attachTabScroll}
            role="tablist"
            aria-label={t("chatPreviewRail.tabsLabel")}
            data-testid="chat-side-panel-tab-scroll"
            className="min-w-0 flex-1 cursor-grab overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden data-[dragging=true]:cursor-grabbing"
            onPointerDown={onTabPointerDown}
            onPointerMove={onTabPointerMove}
            onPointerUp={onTabPointerEnd}
            onPointerCancel={onTabPointerEnd}
            onClickCapture={onTabClickCapture}
          >
          <div className="flex min-w-max gap-1">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab.kind);
              const active = tab.id === activeTab?.id;
              const label = tabLabel(tab, targetById, t);
              const isEphemeral = tab.mode === "ephemeral";
              return (
                // Layout wrapper only (role="presentation"): the pin/close
                // controls are SIBLINGS of the tab button, never nested inside
                // it — an interactive-in-interactive tree is invalid HTML and an
                // a11y violation. Each is a real <button> with native keyboard
                // activation; being siblings, their clicks don't select the tab.
                <div
                  key={tab.id}
                  role="presentation"
                  data-tab-id={tab.id}
                  data-tab-mode={tab.mode}
                  className={`group flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                    active ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground"
                  }`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={active}
                    data-testid={tab.content ? "chat-side-panel-tab" : tabTestId(tab.kind)}
                    className="flex min-w-0 items-center gap-1 rounded-sm text-inherit focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    onClick={() => setActiveTabId(tab.id)}
                    onDoubleClick={() => promoteToPinned(tab.id)}
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span className={`max-w-24 truncate ${isEphemeral ? "italic" : ""}`}>{label}</span>
                  </button>
                  {isEphemeral ? (
                    <button
                      type="button"
                      aria-label={t("chatPreviewRail.pinTab")}
                      data-testid="chat-side-panel-pin-tab"
                      className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                      onClick={() => promoteToPinned(tab.id)}
                    >
                      <Pin className="h-3 w-3" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    aria-label={t("chatPreviewRail.closeTab")}
                    className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    onClick={() => closeWorkspaceTab(tab.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
          </div>
          </div>
          <div className="flex shrink-0 items-center gap-1 border-l pl-2" data-testid="chat-side-panel-tab-actions">
            <WorkspaceLauncherMenu onOpen={addTab} />
          </div>
        </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-hidden" data-active-tab-kind={activeTab?.kind} data-active-tab-mode={activeTab?.mode}>
          {activeTab == null ? (
            <WorkspaceLauncher onOpen={addTab} />
          ) : activeTab.content ? (
            <ContentTabView api={api} sessionId={sessionId} tab={activeTab} targetById={targetById} />
          ) : activeTab.kind === "file-browser" ? (
            <FileBrowserWorkspace
              api={api}
              sessionId={sessionId}
              files={files}
              targetById={targetById}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          ) : activeTab.kind === "browser" ? (
            <BrowserWorkspace
              api={api}
              tabId={activeTab.id}
              targets={browserTargets}
              selectedId={selectedId}
              onSelect={onSelect}
              manualUrl={browserUrlByTab[activeTab.id] ?? null}
              onManualUrlChange={setBrowserTabUrl}
            />
          ) : activeTab.kind === "terminal" ? (
            <PtyTerminalView api={api} tabId={activeTab.id} />
          ) : activeTab.kind === "subagent" ? (
            <SubAgentViewer api={api} subAgentSpawns={subAgentSpawns} />
          ) : activeTab.kind === "side-chat" ? (
            // Unreachable in this PR: side-chat has no launcher entry and no
            // content producer, so a tab of this kind cannot be created until
            // the companion PR ships the 2nd ConversationLoop. This placeholder
            // exists only to keep the body dispatch exhaustive alongside the
            // reserved `side-chat` tab kind (Field-Addition Sweep).
            <div className="p-4 text-xs text-muted-foreground" data-testid="chat-side-panel-side-chat-placeholder">
              {t("chatPreviewRail.sideChatComingSoon")}
            </div>
          ) : (
            <PreviewWorkspace api={api} sessionId={sessionId} targets={previewTargets} selectedId={selectedId} onSelect={onSelect} />
          )}
        </div>
      </div>
    </aside>
  );
}
