import { createElement, useEffect, useMemo, useRef, useState } from "react";
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
  PanelRightClose,
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
import { useTranslation } from "../../../i18n/react.js";
import { wrapRenderHtmlInlineFrameDocument } from "../../../shared/render-html-preview.js";
import { LVIS_SIDE_BROWSER_PARTITION } from "../../../shared/side-browser.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";

type WorkspaceTabKind = "file-browser" | "preview" | "browser" | "terminal";

interface WorkspaceTab {
  id: string;
  kind: WorkspaceTabKind;
  ordinal: number;
  closeable: boolean;
}

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

function normalizeBrowserNavigationUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
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
        <div className="flex flex-wrap gap-2">
          {target.canOpenExternal ? (
            <Button type="button" size="sm" variant="outline" onClick={() => void window.lvis.attach.openExternal(target.path)}>
              <ExternalLink className="h-3.5 w-3.5" />
              <span>{t("chatPreviewRail.openFile")}</span>
            </Button>
          ) : null}
          <CopyButton value={rawText} />
        </div>
        {!target.canOpenExternal ? (
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
      <TextBlock text={rawText} />
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
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-file-browser">
      <SearchInput query={query} setQuery={setQuery} placeholder={t("chatPreviewRail.searchPlaceholder")} />
      <div
        ref={splitLayoutRef}
        className="grid min-h-0 flex-1"
        data-testid="chat-side-panel-file-split-layout"
        style={{ gridTemplateRows: `${treePanePercent}% 0.5rem minmax(0, 1fr)` }}
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
          className="group flex cursor-row-resize items-center px-2 outline-none"
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
          <span className="h-px w-full bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
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
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-browser-workspace">
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
      <div className="min-h-0 flex-1 overflow-hidden">
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
    <div className="flex h-full min-h-0 flex-col" data-testid="chat-side-panel-terminal-workspace">
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
          className="h-8 pl-7 text-xs"
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
    <div className="flex h-full min-h-0 flex-col">
      <SearchInput query={query} setQuery={setQuery} placeholder={placeholder} />
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(10rem,0.85fr)_minmax(14rem,1.15fr)]">
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

function tabCount(kind: WorkspaceTabKind, counts: Record<WorkspaceTabKind, number>): number {
  return counts[kind];
}

function tabTestId(kind: WorkspaceTabKind, closeable: boolean): string | undefined {
  if (closeable) return undefined;
  switch (kind) {
    case "file-browser":
      return "chat-side-panel-mode-files";
    case "browser":
      return "chat-side-panel-mode-browser";
    case "preview":
      return "chat-side-panel-mode-preview";
    case "terminal":
      return "chat-side-panel-mode-terminal";
  }
}

function AddTabButton({
  icon: Icon,
  label,
  testId,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" size="icon-xs" variant="ghost" data-testid={testId} aria-label={label} title={label} onClick={onClick}>
          <Icon className="h-3.5 w-3.5" />
          <Plus className="-ml-1 h-2.5 w-2.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
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
  className = "",
}: ChatSidePanelProps) {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<WorkspaceTab[]>([
    { id: "file-browser:1", kind: "file-browser", ordinal: 1, closeable: false },
    { id: "preview:1", kind: "preview", ordinal: 1, closeable: false },
    { id: "browser:1", kind: "browser", ordinal: 1, closeable: false },
    { id: "terminal:1", kind: "terminal", ordinal: 1, closeable: false },
  ]);
  const [activeTabId, setActiveTabId] = useState("file-browser:1");
  const nextIdRef = useRef(2);
  const nextOrdinalRef = useRef<Record<WorkspaceTabKind, number>>({
    "file-browser": 2,
    preview: 2,
    browser: 2,
    terminal: 2,
  });
  const [browserUrlByTab, setBrowserUrlByTab] = useState<Record<string, string>>({});

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
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const counts: Record<WorkspaceTabKind, number> = {
    "file-browser": files.length,
    preview: previewTargets.length,
    browser: browserTargets.length,
    terminal: terminalTargets.length,
  };

  function addTab(kind: "file-browser" | "browser" | "terminal") {
    const ordinal = nextOrdinalRef.current[kind]++;
    const id = `${kind}:${nextIdRef.current++}`;
    setTabs((current) => [...current, { id, kind, ordinal, closeable: true }]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    setTabs((current) => {
      const closingIndex = current.findIndex((tab) => tab.id === id);
      const next = current.filter((tab) => tab.id !== id);
      if (activeTabId === id) {
        const fallback = next[Math.max(0, closingIndex - 1)] ?? next[0];
        if (fallback) setActiveTabId(fallback.id);
      }
      return next.length > 0 ? next : current;
    });
    setBrowserUrlByTab((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  function setBrowserTabUrl(tabId: string, url: string | null) {
    setBrowserUrlByTab((current) => {
      if (url == null) {
        if (!(tabId in current)) return current;
        const next = { ...current };
        delete next[tabId];
        return next;
      }
      return { ...current, [tabId]: url };
    });
  }

  return (
    <aside
      data-testid="chat-side-panel"
      className={`min-h-0 min-w-0 border-l border-border/(--opacity-strong) bg-background/(--opacity-solid) backdrop-blur ${className}`}
    >
      <div data-testid="chat-preview-rail" className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
          <PanelRightClose className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{t("chatPreviewRail.title")}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {t("chatPreviewRail.subtitle", { targets: targets.length, files: files.length })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <AddTabButton
              icon={Folder}
              label={t("chatPreviewRail.addFileBrowserTab")}
              testId="chat-side-panel-add-file-browser-tab"
              onClick={() => addTab("file-browser")}
            />
            <AddTabButton
              icon={Globe}
              label={t("chatPreviewRail.addBrowserTab")}
              testId="chat-side-panel-add-browser-tab"
              onClick={() => addTab("browser")}
            />
            <AddTabButton
              icon={Terminal}
              label={t("chatPreviewRail.addTerminalTab")}
              testId="chat-side-panel-add-terminal-tab"
              onClick={() => addTab("terminal")}
            />
            <Button type="button" size="icon-xs" variant="ghost" title={t("chatPreviewRail.close")} aria-label={t("chatPreviewRail.close")} onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="shrink-0 overflow-x-auto border-b px-2 py-1" role="tablist" aria-label={t("chatPreviewRail.tabsLabel")}>
          <div className="flex min-w-max gap-1">
            {tabs.map((tab) => {
              const Icon = tabIcon(tab.kind);
              const active = tab.id === activeTab.id;
              const label = t(tabLabelKey(tab.kind));
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={tabTestId(tab.kind, tab.closeable)}
                  className={`flex h-8 min-w-0 items-center gap-1 rounded-md px-2 text-xs transition-colors ${
                    active ? "bg-primary/(--opacity-subtle) text-primary" : "text-muted-foreground hover:bg-muted/(--opacity-muted) hover:text-foreground"
                  }`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="max-w-24 truncate">{tab.closeable ? `${label} ${tab.ordinal}` : label}</span>
                  <span className="font-mono text-[10px] tabular-nums">{tabCount(tab.kind, counts)}</span>
                  {tab.closeable ? (
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
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden" data-active-tab-kind={activeTab.kind}>
          {activeTab.kind === "file-browser" ? (
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
