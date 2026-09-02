import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { Badge } from "../../../components/ui/badge.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import { extractFileEditDiff } from "../utils/file-diff.js";
import type { FileEditDiffData } from "../utils/file-diff.js";
import { getToolDisplayName } from "../utils/tool-display.js";
import { formatDuration } from "../../../lib/turn-summary-format.js";
import type { RenderHtmlPayload } from "../types.js";
import { HtmlPreview } from "./HtmlPreview.js";
import { FileEditDiff, WriteFileSidecarDiff } from "./FileEditDiff.js";
import { McpAppView } from "./McpAppView.js";
import { CompactedToolResult } from "./CompactedToolResult.js";
import { ToolPayloadBlock } from "./ToolPayloadBlock.js";
import { PermissionReviewStatusCard } from "./PermissionReviewStatusCard.js";

type PermissionReviewEntry = Extract<ChatEntry, { kind: "permission_review" }>;

/** toolUseId → permission review verdict for that exact tool call. */
export type PermissionReviewsByToolUseId = ReadonlyMap<string, PermissionReviewEntry>;

/**
 * The verdict belongs to the tool call. Rows with a header cell the chip can
 * sit in render `PermissionReviewStatusCard` inline; the result-only surfaces
 * (compacted result, write_file sidecar) have no such row, so the chip is
 * placed directly under them instead of as an unrelated sibling card.
 */
function AttachedPermissionReview({
  review,
  className,
}: {
  review: PermissionReviewEntry | undefined;
  className: string;
}) {
  if (!review) return null;
  return (
    <div className={className}>
      <PermissionReviewStatusCard entry={review} variant="attached" />
    </div>
  );
}

/**
 * Per-tool execution duration badge — `⏱ 1.4s`. Rendered next to the
 * tool name on every ToolGroupCard row (single-tool inline and grouped
 * rows). Hidden while the tool is running (no duration yet) and when
 * `durationMs` is undefined (legacy stream events from a session that
 * predates the per-tool timer instrumentation).
 */
function ToolDurationBadge({ durationMs }: { durationMs?: number }) {
  // Hiding on a missing or nonsensical duration is this badge's own rule, not
  // the formatter's — `formatDuration` renders `0s` for those, which would put
  // a meaningless stopwatch on the row.
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const label = formatDuration(durationMs);
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums opacity-70"
      title={`${durationMs} ms`}
      data-testid="tool-duration"
    >
      ⏱ {label}
    </span>
  );
}

/**
 * Live ticking elapsed counter while a tool is in-flight. Mirrors the
 * formatted output of `ToolDurationBadge` so a tool's badge shape does
 * not jump when it transitions from running → done. Ticks every 200ms
 * — fine-grained enough to feel alive on short calls, cheap enough not
 * to thrash React for long ones. Returns null until `startedAt` is set
 * (legacy stream events without per-tool start timestamps).
 */
function RunningDurationBadge({ startedAt }: { startedAt?: number }) {
  const { t } = useTranslation();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (typeof startedAt !== "number") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  if (typeof startedAt !== "number") return null;
  const elapsed = Math.max(0, now - startedAt);
  const label = formatDuration(elapsed);
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums opacity-70"
      title={`${elapsed} ms (${t("toolGroupCard.running")})`}
      data-testid="tool-duration-running"
      aria-live="polite"
    >
      ⏱ {label}
    </span>
  );
}

type ToolItem = Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];

function toolSourceLabel(tool: ToolItem): string | null {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  if (tool.source === "builtin") return "builtin";
  return null;
}

function ToolSourceBadge({ tool }: { tool: ToolItem }) {
  const { t } = useTranslation();
  const label = toolSourceLabel(tool);
  if (!label) return null;
  const title = tool.category
    ? t("toolGroupCard.toolSourceWithCategoryTitle", {
      source: label,
      category: tool.category,
    })
    : t("toolGroupCard.toolSourceTitle", { source: label });
  return (
    <Badge
      variant="outline"
      className="max-w-[160px] shrink-0 truncate px-1 py-0 font-mono text-[9px]"
      title={title}
      data-testid="tool-source"
    >
      {label}
    </Badge>
  );
}

/**
 * Per-tool status pill — "실패" (error) or "완료" (done). Single source for the
 * success/failure badge shown on every collapsed tool row (single-tool inline
 * + grouped per-tool).
 */
function ToolStatusBadge({
  status,
}: {
  status: ToolItem["status"];
}) {
  const { t } = useTranslation();
  const isError = status === "error";
  // A user stop is neither a failure nor a completion. `status` carries it as
  // its own value, so every `=== "error"` check elsewhere already excludes it;
  // only the label has to say which of the three happened.
  const isCancelled = status === "cancelled";

  return (
    <Badge
      variant={isError ? "secondary" : "default"}
      className={`shrink-0 px-1 py-0 text-[10px] ${isError ? "text-destructive" : ""} ${isCancelled ? "text-muted-foreground" : ""}`}
      data-testid="tool-status"
    >
      {isError
        ? t("toolGroupCard.failed")
        : isCancelled
          ? t("toolGroupCard.cancelled")
          : t("toolGroupCard.done")}
    </Badge>
  );
}

function isToolResultStub(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (value.startsWith("[tool_result stripped:") ||
      value.startsWith("[tool_result truncated by host"))
  );
}

/** Single-tool inline indicator — no collapsible wrapper */
function SingleToolInline({
  tool,
  sessionId,
  review,
}: {
  tool: Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];
  sessionId?: string;
  review?: PermissionReviewEntry;
}) {
  const { t } = useTranslation();
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const [open, setOpen] = useState(false);
  const previousToolRef = useRef({ toolUseId: tool.toolUseId, status: tool.status });
  const shouldAutoOpenHtml =
    previousToolRef.current.toolUseId === tool.toolUseId &&
    previousToolRef.current.status === "running" &&
    tool.status === "done";

  useEffect(() => {
    previousToolRef.current = { toolUseId: tool.toolUseId, status: tool.status };
  }, [tool.status, tool.toolUseId]);

  // Stub result — render collapsible CompactedToolResult instead of raw block.
  // Compaction marks tool_results by role+length, independent of error status,
  // so error tool_results can also be stubs.
  const isStubResult = !isRunning && isToolResultStub(tool.result);

  if (isStubResult && sessionId) {
    return (
      <>
        <CompactedToolResult
          toolUseId={tool.toolUseId}
          toolName={getToolDisplayName(tool.name)}
          input={tool.input}
          compactedResultText={tool.result as string}
          sessionId={sessionId}
        />
        <AttachedPermissionReview review={review} className="px-3 pb-1.5" />
      </>
    );
  }

  // Issue #749: write_file results with truncated+hasSidecar render via sidecar IPC.
  const isWriteFileSidecar =
    !isRunning &&
    !isError &&
    tool.name === "write_file" &&
    typeof tool.result === "string" &&
    sessionId &&
    (() => {
      try {
        const p = JSON.parse(tool.result) as Record<string, unknown>;
        return p.truncated === true && p.hasSidecar === true;
      } catch {
        return false;
      }
    })();

  if (isWriteFileSidecar && sessionId) {
    return (
      <>
        <WriteFileSidecarDiff
          resultJson={tool.result as string}
          sessionId={sessionId}
          toolUseId={tool.toolUseId}
          filePath={typeof tool.input?.path === "string" ? tool.input.path : undefined}
        />
        <AttachedPermissionReview review={review} className="px-3 pb-1.5" />
      </>
    );
  }

  const htmlPayload: RenderHtmlPayload | null =
    tool.name === "render_html" && tool.status === "done"
      ? parseRenderHtmlResult(tool.result)
      : null;
  const htmlNeedsJavaScript =
    htmlPayload != null && /<script\b|on[a-z]+\s*=|javascript:/i.test(htmlPayload.html);
  const fileDiff: FileEditDiffData | null = extractFileEditDiff(tool);
  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-[11px] text-muted-foreground">
      {/* The header is a wrapping flex surface rather than one <button>: the
          review chip is a focusable tooltip trigger, and interactive content
          cannot nest inside a button. The name group stays the real button
          (keyboard toggle, aria-expanded); its click bubbles up to the row,
          which is the pointer target. Cells wrap in DOM order when the row is
          too narrow — the chip is the widest cell, so it drops first. */}
      <div
        className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 hover:bg-muted/(--opacity-muted)"
        onClick={() => setOpen((o) => !o)}
        data-testid="tool-row-header"
      >
        <button
          type="button"
          className="flex min-w-0 max-w-full items-center gap-2 text-left"
          aria-expanded={open}
        >
          <Wrench className="h-3 w-3 flex-shrink-0" />
          <span className="min-w-0 truncate font-medium">{getToolDisplayName(tool.name)}</span>
          <ToolSourceBadge tool={tool} />
        </button>
        {review && <PermissionReviewStatusCard entry={review} variant="attached" />}
        {isRunning ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <ToolStatusBadge status={tool.status} />
        )}
        {isRunning
          ? <RunningDurationBadge startedAt={tool.startedAt} />
          : <ToolDurationBadge durationMs={tool.durationMs} />}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
      </div>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-1.5 font-mono text-[10px] lvis-anim-fade-in">
          {tool.input && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase opacity-60">{t("toolGroupCard.input")}</div>
              <ToolPayloadBlock value={tool.input} />
            </div>
          )}
          {tool.result !== undefined && (
            <div>
              <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${isError ? "text-destructive" : ""}`}>{isError ? t("toolGroupCard.error") : t("toolGroupCard.result")}</div>
              <ToolPayloadBlock value={tool.result} isError={isError} />
            </div>
          )}
        </div>
      )}
      {htmlPayload && (
        <div className="space-y-2 border-t px-3 py-2">
          <HtmlPreview
            payload={htmlPayload}
            requiresScripts={htmlNeedsJavaScript}
            autoOpen={shouldAutoOpenHtml}
            autoOpenKey={tool.toolUseId}
          />
        </div>
      )}
      {fileDiff && (
        <div className="border-t px-3 py-2">
          <FileEditDiff data={fileDiff} />
        </div>
      )}
      {tool.status === "done" && tool.uiPayload && (
        <McpAppView key={tool.toolUseId} payload={tool.uiPayload} />
      )}
    </div>
  );
}

export function ToolGroupCard({
  group,
  sessionId,
  permissionReviews,
}: {
  group: Extract<ChatEntry, { kind: "tool_group" }>;
  /** Active session id for verbatim IPC fetch. When provided, stub results render as CompactedToolResult. */
  sessionId?: string;
  /** Permission review verdicts to render on their own tool rows. */
  permissionReviews?: PermissionReviewsByToolUseId;
}) {
  // All hooks must be declared before any conditional return (Rules of Hooks)
  const { t } = useTranslation();
  const tools = [...group.tools].sort((a, b) => a.displayOrder - b.displayOrder);
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set());
  const previousStatusesRef = useRef<Map<string, string>>(
    new Map(tools.map((tool) => [tool.toolUseId, tool.status])),
  );
  const autoOpenHtmlToolIds = useMemo(
    () => new Set(
      tools
        .filter((tool) =>
          tool.name === "render_html" &&
          tool.status === "done" &&
          previousStatusesRef.current.get(tool.toolUseId) === "running")
        .map((tool) => tool.toolUseId),
    ),
    [tools],
  );

  useEffect(() => {
    previousStatusesRef.current = new Map(tools.map((tool) => [tool.toolUseId, tool.status]));
  }, [tools]);

  // Single tool: render inline without group wrapper
  if (group.tools.length === 1 && group.tools[0]) {
    return (
      <SingleToolInline
        tool={group.tools[0]}
        sessionId={sessionId}
        review={permissionReviews?.get(group.tools[0].toolUseId)}
      />
    );
  }
  const doneCount = group.tools.filter((t) => t.status !== "running").length;
  const hasError = group.tools.some((t) => t.status === "error");
  const groupStatus = group.status === "running"
    ? "running"
    : hasError ? "error" : "done";
  const groupTitle = groupStatus === "running" ? t("toolGroupCard.toolsRunning") : t("toolGroupCard.toolsResult");
  function toggleTool(id: string) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const uniqueToolNames = [...new Set(tools.map((t) => getToolDisplayName(t.name)))].join(" · ");
  const uniqueSourceLabels = [...new Set(tools.map((t) => toolSourceLabel(t)).filter((label): label is string => label !== null))].join(" · ");
  const htmlPreviews = tools
    .filter((t) => t.name === "render_html" && t.status === "done")
    .map((t) => ({ toolUseId: t.toolUseId, payload: parseRenderHtmlResult(t.result) }))
    .filter((p): p is { toolUseId: string; payload: RenderHtmlPayload } => p.payload !== null);

  const fileDiffs = tools
    .map((t) => {
      const data = extractFileEditDiff(t);
      return data != null ? { toolUseId: t.toolUseId, data } : null;
    })
    .filter((entry): entry is { toolUseId: string; data: FileEditDiffData } => entry !== null);

  // MCP Apps §3.2 — collect tools that carry a uiPayload
  const mcpAppPreviews = tools.filter(
    (t) => t.status === "done" && t.uiPayload != null,
  );

  function previewNeedsJavaScript(payload: RenderHtmlPayload): boolean {
    return /<script\b|on[a-z]+\s*=|javascript:/i.test(payload.html);
  }

  return (
    <div className="min-w-0 w-full max-w-full rounded-md text-[11px] text-muted-foreground lvis-anim-message-in">
      <button
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-muted/(--opacity-muted)"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="shrink-0 font-medium">{groupTitle}</span>
        <span className="min-w-0 truncate text-[10px] opacity-60">{uniqueToolNames}</span>
        {uniqueSourceLabels && (
          <span
            className="max-w-[180px] shrink-0 truncate font-mono text-[9px] opacity-70"
            title={`tool sources: ${uniqueSourceLabels}`}
          >
            {uniqueSourceLabels}
          </span>
        )}
        <Badge variant="outline" className="px-1 py-0 text-[10px] flex-shrink-0">
          {groupStatus === "running" ? `${doneCount}/${group.tools.length}` : t("toolGroupCard.toolCount", { count: group.tools.length })}
        </Badge>
        {groupStatus === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
        ) : (
          <Badge
            variant={groupStatus === "error" ? "secondary" : "default"}
            className={`px-1 py-0 text-[10px] flex-shrink-0 ${groupStatus === "error" ? "text-destructive" : ""}`}
          >
            {groupStatus === "error" ? t("toolGroupCard.hasErrors") : t("toolGroupCard.done")}
          </Badge>
        )}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-1.5 lvis-anim-fade-in">
          {tools.map((tool) => {
            const isExpanded = expandedTools.has(tool.toolUseId);
            const review = permissionReviews?.get(tool.toolUseId);
            return (
              <div key={tool.toolUseId} className="min-w-0 rounded border border-dashed/50">
                {/* Same row contract as the single-tool header above. */}
                <div
                  className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1 hover:bg-muted/(--opacity-light)"
                  onClick={() => toggleTool(tool.toolUseId)}
                  data-testid="tool-row-header"
                >
                  <button
                    type="button"
                    className="flex min-w-0 max-w-full items-center gap-2 text-left"
                    aria-expanded={isExpanded}
                  >
                    {isExpanded ? <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />}
                    <span className="min-w-0 truncate">{getToolDisplayName(tool.name)}</span>
                    <ToolSourceBadge tool={tool} />
                  </button>
                  {review && <PermissionReviewStatusCard entry={review} variant="attached" />}
                  {tool.status === "running" ? (
                    <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
                  ) : (
                    <ToolStatusBadge status={tool.status} />
                  )}
                  {tool.status === "running"
                    ? <RunningDurationBadge startedAt={tool.startedAt} />
                    : <ToolDurationBadge durationMs={tool.durationMs} />}
                </div>
                {isExpanded && (
                  <div className="min-w-0 space-y-1 border-t px-2 py-1 font-mono text-[10px] lvis-anim-fade-in">
                    {tool.input && (
                      <div>
                        <div className="mb-0.5 text-[9px] uppercase opacity-60">{t("toolGroupCard.input")}</div>
                        <ToolPayloadBlock value={tool.input} />
                      </div>
                    )}
                    {tool.result !== undefined && (
                      <div>
                        <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${tool.status === "error" ? "text-destructive" : ""}`}>
                          {tool.status === "error" ? t("toolGroupCard.error") : t("toolGroupCard.result")}
                        </div>
                        {/* Stub results render as collapsible CompactedToolResult. */}
                        {isToolResultStub(tool.result) && sessionId ? (
                          <CompactedToolResult
                            toolUseId={tool.toolUseId}
                            toolName={getToolDisplayName(tool.name)}
                            input={tool.input}
                            compactedResultText={tool.result}
                            sessionId={sessionId}
                          />
                        ) : /* Issue #749: write_file truncated+hasSidecar → WriteFileSidecarDiff */
                        tool.status !== "error" &&
                          tool.name === "write_file" &&
                          sessionId &&
                          (() => {
                            try {
                              const p = JSON.parse(tool.result) as Record<string, unknown>;
                              return p.truncated === true && p.hasSidecar === true;
                            } catch {
                              return false;
                            }
                          })() ? (
                          <WriteFileSidecarDiff
                            resultJson={tool.result}
                            sessionId={sessionId}
                            toolUseId={tool.toolUseId}
                            filePath={typeof tool.input?.path === "string" ? tool.input.path : undefined}
                          />
                        ) : (
                          <ToolPayloadBlock value={tool.result} isError={tool.status === "error"} />
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {htmlPreviews.length > 0 && (
        <div className="border-t px-3 py-2">
          {htmlPreviews.map((p) => (
            <div key={p.toolUseId} className="space-y-2">
              <HtmlPreview
                payload={p.payload}
                requiresScripts={previewNeedsJavaScript(p.payload)}
                autoOpen={autoOpenHtmlToolIds.has(p.toolUseId)}
                autoOpenKey={p.toolUseId}
              />
            </div>
          ))}
        </div>
      )}
      {fileDiffs.length > 0 && (
        <div className="space-y-2 border-t px-3 py-2">
          {fileDiffs.map((entry) => (
            <FileEditDiff key={entry.toolUseId} data={entry.data} />
          ))}
        </div>
      )}
      {mcpAppPreviews.length > 0 && (
        <div className="border-t px-3 py-2 space-y-2">
          {mcpAppPreviews.map((t) => (
            t.uiPayload && <McpAppView key={t.toolUseId} payload={t.uiPayload} />
          ))}
        </div>
      )}
    </div>
  );
}
