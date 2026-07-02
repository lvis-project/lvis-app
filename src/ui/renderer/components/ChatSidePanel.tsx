import { createElement, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { WorkspaceTab, WorkspaceTabKind, WorkspaceTabsStore } from "../preview/workspace-tabs.js";
import {
  WORKSPACE_TAB_LAUNCHER,
  matchesLauncherShortcut,
} from "./command-actions.js";
import {
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
  LayoutGrid,
  PanelRightClose,
  Pin,
  Plug,
  Plus,
  Search,
  Table,
  Terminal,
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
import { useTranslation } from "../../../i18n/react.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../shared/side-panel.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { normalizeBrowserNavigationUrl } from "../preview/url-safety.js";
import { PreviewContent } from "../preview/preview-renderers.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";

interface FileTreeNode {
  id: string;
  label: string;
  path: string;
  file?: WorkspaceFileItem;
  children: FileTreeNode[];
}

const FILE_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["file", "diff", "image"]);
const BROWSER_TARGET_KINDS = new Set<ChatPreviewTarget["kind"]>(["html", "url"]);
const TERMINAL_TOOL_PATTERN = /(^|[._:-])(shell|bash|cmd|powershell|terminal|exec|run)([._:-]|$)/i;
const FILE_TREE_MIN_PERCENT = 22;
const FILE_TREE_MAX_PERCENT = 72;

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

function isTerminalTarget(target: ChatPreviewTarget): boolean {
  return Boolean(target.toolName && TERMINAL_TOOL_PATTERN.test(target.toolName));
}

function terminalText(target: ChatPreviewTarget): string {
  if (target.kind === "tool-result") return target.raw;
  if (target.kind === "json") return target.raw;
  if (target.kind === "paste") return target.text;
  if (target.kind === "file" || target.kind === "diff" || target.kind === "image") return target.path;
  if (target.kind === "url") return target.url;
  if (target.kind === "plugin") return target.resourceUri;
  if (target.kind === "html") return target.payload.html;
  return "";
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
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
          {target.path}
        </div>
        {target.inlineText ? (
          <PreviewContent descriptor={{ text: target.inlineText, path: target.path }} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {target.canOpenExternal ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void window.lvis.attach.openExternal(target.path)}>
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{t("chatPreviewRail.openFile")}</span>
            </Button>
          ) : null}
          <CopyButton value={target.inlineText ?? rawText} />
        </div>
        {!target.canOpenExternal && !target.inlineText ? (
          <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.pathOnlyHint")}</div>
        ) : null}
      </div>
    );
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

function UrlDocumentViewer({ api, target }: { api: LvisApi; target: Extract<ChatPreviewTarget, { kind: "url" }> }) {
  const { t } = useTranslation();
  const url = useMemo(() => {
    try {
      const parsed = new URL(target.url);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
    } catch {
      return null;
    }
  }, [target.url]);

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
  const [treePanePercent, setTreePanePercent] = useState(45);
  const splitLayoutRef = useRef<HTMLDivElement | null>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
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

  useEffect(() => {
    if (selectedFile?.previewTargetId && selectedFile.previewTargetId !== selectedId) {
      onSelect(selectedFile.previewTargetId);
    }
  }, [onSelect, selectedFile, selectedId]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  const updateTreePaneFromClientY = (clientY: number) => {
    const layout = splitLayoutRef.current;
    if (!layout) return;
    const rect = layout.getBoundingClientRect();
    if (rect.height <= 0) return;
    const next = ((clientY - rect.top) / rect.height) * 100;
    setTreePanePercent(clampNumber(Math.round(next), FILE_TREE_MIN_PERCENT, FILE_TREE_MAX_PERCENT));
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-file-browser">
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      {!hasFiles ? (
        <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="chat-side-panel-file-empty">
          <EmptyState>{t("chatPreviewRail.noFiles")}</EmptyState>
        </div>
      ) : (
      <div
        ref={splitLayoutRef}
        className="grid min-h-0 w-full min-w-0 flex-1 overflow-hidden"
        data-testid="chat-side-panel-file-split-layout"
        style={{ gridTemplateRows: `${treePanePercent}% 0.75rem minmax(0, 1fr)` }}
      >
        <div className="min-h-0 overflow-auto border-b p-2" data-testid="chat-side-panel-file-tree">
          {tree.length > 0 ? (
            <FileTreeRows
              nodes={tree}
              selectedFileId={selectedFile?.id}
              onSelectFile={(file) => {
                if (file.previewTargetId) onSelect(file.previewTargetId);
              }}
            />
          ) : (
            <EmptyState>{t("chatPreviewRail.noFiles")}</EmptyState>
          )}
        </div>
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("chatPreviewRail.resizeFilePanels")}
          tabIndex={0}
          data-testid="chat-side-panel-file-splitter"
          className="group flex cursor-row-resize touch-none select-none items-center px-2 outline-none"
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            resizeCleanupRef.current?.();
            updateTreePaneFromClientY(event.clientY);
            const onMove = (moveEvent: PointerEvent) => updateTreePaneFromClientY(moveEvent.clientY);
            const cleanup = () => {
              window.removeEventListener("pointermove", onMove);
              window.removeEventListener("pointerup", cleanup);
              window.removeEventListener("pointercancel", cleanup);
              resizeCleanupRef.current = null;
            };
            resizeCleanupRef.current = cleanup;
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", cleanup);
            window.addEventListener("pointercancel", cleanup);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setTreePanePercent((value) => clampNumber(value - 5, FILE_TREE_MIN_PERCENT, FILE_TREE_MAX_PERCENT));
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setTreePanePercent((value) => clampNumber(value + 5, FILE_TREE_MIN_PERCENT, FILE_TREE_MAX_PERCENT));
            } else if (event.key === "Home") {
              event.preventDefault();
              setTreePanePercent(FILE_TREE_MIN_PERCENT);
            } else if (event.key === "End") {
              event.preventDefault();
              setTreePanePercent(FILE_TREE_MAX_PERCENT);
            }
          }}
        >
          <span className="h-0.5 w-full rounded-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
        </div>
        <div className="min-h-0 overflow-auto p-3">
          {selectedFileTarget ? (
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
      </div>
      )}
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
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      <div className="max-h-36 shrink-0 overflow-auto border-b p-2">
        {filteredTargets.length > 0 ? (
          <TargetRows
            targets={filteredTargets}
            selectedId={manualTarget ? undefined : selectedTarget?.id}
            rowTestId="chat-side-panel-browser-row"
            onSelect={(id) => {
              onManualUrlChange(tabId, null);
              onSelect(id);
            }}
          />
        ) : (
          <EmptyState>{t("chatPreviewRail.noBrowserTargets")}</EmptyState>
        )}
      </div>
      <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">
        {displayedTarget?.kind === "html" ? (
          <BrowserDocumentViewer target={displayedTarget} />
        ) : displayedTarget?.kind === "url" ? (
          <UrlDocumentViewer api={api} target={displayedTarget} />
        ) : (
          <div className="text-xs text-muted-foreground">{t("chatPreviewRail.noBrowserTargets")}</div>
        )}
      </div>
    </div>
  );
}

function TerminalWorkspace({
  targets,
  selectedId,
  onSelect,
}: {
  targets: ChatPreviewTarget[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, terminalText(target))),
    [targets, query],
  );
  const selectedTarget = useMemo(
    () => filteredTargets.find((target) => target.id === selectedId) ?? filteredTargets[0] ?? null,
    [filteredTargets, selectedId],
  );
  const output = selectedTarget ? terminalText(selectedTarget) : "";

  useEffect(() => {
    if (selectedTarget && selectedTarget.id !== selectedId) onSelect(selectedTarget.id);
  }, [onSelect, selectedId, selectedTarget]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden" data-testid="chat-side-panel-terminal-workspace">
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.terminalSearchPlaceholder")} />
      <div className="max-h-32 shrink-0 overflow-auto border-b p-2">
        {filteredTargets.length > 0 ? (
          <TargetRows targets={filteredTargets} selectedId={selectedTarget?.id} rowTestId="chat-side-panel-terminal-row" onSelect={onSelect} />
        ) : (
          <EmptyState>{t("chatPreviewRail.noTerminalTargets")}</EmptyState>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-foreground p-3 text-background" data-testid="chat-side-panel-terminal-output">
        {selectedTarget ? (
          <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">{output}</pre>
        ) : (
          <div className="text-xs text-background/(--opacity-muted)">{t("chatPreviewRail.noTerminalTargets")}</div>
        )}
      </div>
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
  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden">
      <SearchInput query={query} setQuery={setQuery} placeholder={placeholder} />
      <div className="grid min-h-0 w-full min-w-0 flex-1 grid-rows-[minmax(10rem,0.85fr)_minmax(14rem,1.15fr)] overflow-hidden">
        <div className="min-h-0 overflow-auto border-b p-2">
          {rows.length > 0 ? (
            <TargetRows targets={rows} selectedId={selectedTarget?.id} rowTestId={rowTestId} onSelect={onSelect} />
          ) : (
            <EmptyState>{emptyText}</EmptyState>
          )}
        </div>
        <div className="min-h-0 overflow-auto p-3">
          {selectedTarget ? (
            <div className="space-y-3">
              <DetailHeader target={selectedTarget} />
              <PreviewBody api={api} sessionId={sessionId} target={selectedTarget} />
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">{emptyText}</div>
          )}
        </div>
      </div>
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
  if (!content) return null;
  if (content.source === "browser") {
    let title = content.url;
    try {
      title = new URL(content.url).hostname || content.url;
    } catch {
      title = content.url;
    }
    const target: Extract<ChatPreviewTarget, { kind: "url" }> = {
      id: `content-browser:${tab.id}`,
      kind: "url",
      title,
      sourceLabel: t("chatPreviewRail.manualUrlSource"),
      createdOrder: Number.MAX_SAFE_INTEGER,
      url: content.url,
    };
    return <UrlDocumentViewer api={api} target={target} />;
  }
  const target = targetById.get(content.targetId);
  if (!target) {
    return (
      <div className="p-4 text-xs text-muted-foreground" data-testid="chat-side-panel-content-unavailable">
        {t("chatPreviewRail.contentUnavailable")}
      </div>
    );
  }
  return (
    <div className="h-full min-h-0 overflow-auto p-3" data-testid="chat-side-panel-content-view">
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

  const updateWidthFromClientX = (clientX: number) => {
    const el = asideRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 12rem viewport margin == the max-w-[calc(100vw-12rem)] safety cap.
    const max = Math.max(SIDE_PANEL_MIN_WIDTH, window.innerWidth - 192);
    // Panel is right-docked: the right edge is fixed, dragging the left edge
    // leftwards widens it.
    const next = rect.right - clientX;
    onWidthChange(clampNumber(Math.round(next), SIDE_PANEL_MIN_WIDTH, max));
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

  const targetById = useMemo(
    () => new Map(targets.map((target) => [target.id, target])),
    [targets],
  );
  const browserTargets = useMemo(
    () => targets.filter((target) => BROWSER_TARGET_KINDS.has(target.kind)),
    [targets],
  );
  const previewTargets = useMemo(
    () => targets.filter((target) => !FILE_TARGET_KINDS.has(target.kind) && !BROWSER_TARGET_KINDS.has(target.kind) && !isTerminalTarget(target)),
    [targets],
  );
  const terminalTargets = useMemo(
    () => targets.filter(isTerminalTarget),
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
          updateWidthFromClientX(event.clientX);
          const onMove = (moveEvent: PointerEvent) => updateWidthFromClientX(moveEvent.clientX);
          const cleanup = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", cleanup);
            window.removeEventListener("pointercancel", cleanup);
            resizeCleanupRef.current = null;
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
          <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label={t("chatPreviewRail.tabsLabel")}>
          <div className="flex min-w-max gap-1">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab.kind);
              const active = tab.id === activeTab?.id;
              const label = tabLabel(tab, targetById, t);
              const isEphemeral = tab.mode === "ephemeral";
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={tab.content ? "chat-side-panel-tab" : tabTestId(tab.kind)}
                  data-tab-id={tab.id}
                  data-tab-mode={tab.mode}
                  className={`flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                    active ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground"
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                  onDoubleClick={() => promoteToPinned(tab.id)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className={`max-w-24 truncate ${isEphemeral ? "italic" : ""}`}>{label}</span>
                  {isEphemeral ? (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t("chatPreviewRail.pinTab")}
                      data-testid="chat-side-panel-pin-tab"
                      className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted)"
                      onClick={(event) => {
                        event.stopPropagation();
                        promoteToPinned(tab.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          event.stopPropagation();
                          promoteToPinned(tab.id);
                        }
                      }}
                    >
                      <Pin className="h-3 w-3" />
                    </span>
                  ) : null}
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={t("chatPreviewRail.closeTab")}
                    className="ml-0.5 rounded p-0.5 hover:bg-background/(--opacity-muted)"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeTab(tab.id);
                      }
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                </button>
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
            <TerminalWorkspace targets={terminalTargets} selectedId={selectedId} onSelect={onSelect} />
          ) : (
            <PreviewWorkspace api={api} sessionId={sessionId} targets={previewTargets} selectedId={selectedId} onSelect={onSelect} />
          )}
        </div>
      </div>
    </aside>
  );
}
