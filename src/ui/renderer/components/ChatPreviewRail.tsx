import { useEffect, useMemo, useState } from "react";
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  File,
  FileCode,
  FileText,
  Globe,
  Image,
  PanelRightClose,
  Plug,
  Search,
  Table,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Badge } from "../../../components/ui/badge.js";
import { useTranslation } from "../../../i18n/react.js";
import type { LvisApi } from "../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../preview/preview-targets.js";
import { HtmlPreview } from "./HtmlPreview.js";
import { FileEditDiff } from "./FileEditDiff.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { McpAppView } from "./McpAppView.js";

type RailTab = "preview" | "files";

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
  const { copied, copy } = useCopyFlash();
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
              : "";

  const copyButton = rawText ? (
    <Button type="button" size="sm" variant="outline" onClick={() => copy(rawText)}>
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      <span>{copied ? t("chatPreviewRail.copied") : t("chatPreviewRail.copy")}</span>
    </Button>
  ) : null;

  if (target.kind === "html") {
    return (
      <div className="space-y-3">
        <HtmlPreview
          payload={target.payload}
          requiresScripts={/<script\b|on[a-z]+\s*=|javascript:/i.test(target.payload.html)}
        />
        {copyButton}
      </div>
    );
  }

  if (target.kind === "diff") {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 font-mono text-[11px] [overflow-wrap:anywhere]">
          {target.path}
        </div>
        <FileEditDiff data={target.diff} />
        {copyButton}
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
          {copyButton}
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
          {copyButton}
        </div>
        {!target.canOpenExternal ? (
          <div className="text-[11px] text-muted-foreground">{t("chatPreviewRail.pathOnlyHint")}</div>
        ) : null}
      </div>
    );
  }

  if (target.kind === "url") {
    return (
      <div className="space-y-3">
        <div className="rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs [overflow-wrap:anywhere]">
          {target.url}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void api.openExternalUrl(target.url)}>
            <ExternalLink className="h-3.5 w-3.5" />
            <span>{t("chatPreviewRail.openUrl")}</span>
          </Button>
          {copyButton}
        </div>
      </div>
    );
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
        {copyButton}
      </div>
    );
  }

  if (target.kind === "json") {
    return (
      <div className="space-y-3">
        <ToolPayloadBlock value={target.value} />
        {copyButton}
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
      {copyButton}
    </div>
  );
}

export function ChatPreviewRail({
  api,
  sessionId,
  targets,
  files,
  selectedId,
  onSelect,
  onClose,
  className = "",
}: {
  api: LvisApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RailTab>("preview");
  const [query, setQuery] = useState("");
  const selected = useMemo(
    () => targets.find((target) => target.id === selectedId) ?? targets[0] ?? null,
    [selectedId, targets],
  );
  const filteredTargets = useMemo(
    () => targets.filter((target) => matchesQuery(query, target.title, target.subtitle, target.sourceLabel, target.toolName)),
    [query, targets],
  );
  const filteredFiles = useMemo(
    () => files.filter((file) => matchesQuery(query, file.label, file.detail, file.path, file.sourceLabel)),
    [files, query],
  );

  useEffect(() => {
    if (tab === "preview" && filteredTargets.length === 0 && filteredFiles.length > 0) setTab("files");
  }, [filteredFiles.length, filteredTargets.length, tab]);

  return (
    <aside
      data-testid="chat-preview-rail"
      className={`min-h-0 min-w-0 border-l border-border/(--opacity-strong) bg-background/(--opacity-solid) backdrop-blur ${className}`}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <PanelRightClose className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{t("chatPreviewRail.title")}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {t("chatPreviewRail.subtitle", { targets: targets.length, files: files.length })}
            </div>
          </div>
          <Button type="button" size="icon-xs" variant="ghost" title={t("chatPreviewRail.close")} aria-label={t("chatPreviewRail.close")} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b px-3 py-2">
          <div className="flex gap-1 rounded-md bg-muted/(--opacity-muted) p-1">
            <button
              type="button"
              data-testid="chat-preview-preview-tab"
              className={`min-w-0 flex-1 rounded px-2 py-1 text-xs ${tab === "preview" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
              onClick={() => setTab("preview")}
            >
              {t("chatPreviewRail.previewTab", { count: targets.length })}
            </button>
            <button
              type="button"
              data-testid="chat-preview-files-tab"
              className={`min-w-0 flex-1 rounded px-2 py-1 text-xs ${tab === "files" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
              onClick={() => setTab("files")}
            >
              {t("chatPreviewRail.filesTab", { count: files.length })}
            </button>
          </div>
          <div className="relative mt-2">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              data-testid="chat-preview-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("chatPreviewRail.searchPlaceholder")}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[minmax(8rem,0.9fr)_minmax(12rem,1.4fr)]">
          <div className="min-h-0 overflow-auto border-b">
            {tab === "preview" ? (
              filteredTargets.length > 0 ? (
                <div className="space-y-1 p-2">
                  {filteredTargets.map((target) => (
                    <button
                      key={target.id}
                      type="button"
                      data-testid="chat-preview-target-row"
                      className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted) ${selected?.id === target.id ? "bg-accent text-accent-foreground" : ""}`}
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
              ) : (
                <div className="p-4 text-xs text-muted-foreground">{t("chatPreviewRail.noPreviewTargets")}</div>
              )
            ) : filteredFiles.length > 0 ? (
              <div className="space-y-1 p-2">
                {filteredFiles.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    data-testid="chat-preview-file-row"
                    className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/(--opacity-muted)"
                    onClick={() => {
                      if (file.previewTargetId) {
                        onSelect(file.previewTargetId);
                        setTab("preview");
                      }
                    }}
                  >
                    <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{file.label}</span>
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground">{file.detail}</span>
                    </span>
                    <Badge variant="outline" className="shrink-0 px-1 py-0 text-[10px]">
                      {t(`chatPreviewRail.operation.${file.operation}`)}
                    </Badge>
                  </button>
                ))}
              </div>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">{t("chatPreviewRail.noFiles")}</div>
            )}
          </div>

          <div className="min-h-0 overflow-auto p-3">
            {selected ? (
              <div className="space-y-3">
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="text-muted-foreground">{targetIcon(selected.kind)}</span>
                    <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{selected.title}</h3>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1 text-[10.5px] text-muted-foreground">
                    <Badge variant="outline" className="px-1 py-0 text-[10px]">{selected.kind}</Badge>
                    <span className="truncate">{selected.subtitle ?? selected.sourceLabel}</span>
                  </div>
                </div>
                <PreviewBody api={api} sessionId={sessionId} target={selected} />
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{t("chatPreviewRail.emptyState")}</div>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}
