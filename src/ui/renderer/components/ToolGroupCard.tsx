import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { ScrollArea } from "../../../components/ui/scroll-area.js";

/** Pretty, bounded code block for tool input/output. */
function ToolPayloadBlock({ value, isError = false }: { value: string; isError?: boolean }) {
  const formatted = useMemo(() => formatToolPayload(value), [value]);
  const scrollable = shouldConstrainPayload(formatted);
  const pre = (
    <pre
      className={`max-w-full whitespace-pre-wrap break-words px-2 py-1.5 font-mono text-[10px] leading-[1.35rem] [overflow-wrap:anywhere] ${
        isError ? "text-destructive" : "text-muted-foreground"
      }`}
    >
      {formatted}
    </pre>
  );
  return (
    <div className="min-w-0 max-w-full rounded bg-muted/70 ring-1 ring-border/50">
      {scrollable ? <ScrollArea className="h-[6.9rem]">{pre}</ScrollArea> : pre}
    </div>
  );
}

function shouldConstrainPayload(value: string): boolean {
  const lines = value.split("\n");
  if (lines.length > 5) return true;
  // Long JSON/XML/RSS strings often wrap visually into many rows without
  // containing newline characters. Approximate wrapped rows so every tool
  // input/output follows the same "about 5 visible lines" rule.
  const estimatedVisualLines = lines.reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / 96)),
    0,
  );
  return estimatedVisualLines > 5;
}
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { parseRenderHtmlResult } from "../utils/html-preview.js";
import { extractFileEditDiff } from "../utils/file-diff.js";
import type { FileEditDiffData } from "../utils/file-diff.js";
import { getToolDisplayName } from "../utils/tool-display.js";
import { formatToolDuration } from "../utils/format-duration.js";
import type { RenderHtmlPayload } from "../types.js";
import { HtmlPreview } from "./HtmlPreview.js";
import { FileEditDiff, WriteFileSidecarDiff } from "./FileEditDiff.js";
import { McpAppView } from "./McpAppView.js";
import { CompactedToolResult } from "./CompactedToolResult.js";

/**
 * Per-tool execution duration badge — `⏱ 1.4s`. Rendered next to the
 * tool name on every ToolGroupCard row (single-tool inline and grouped
 * rows). Hidden while the tool is running (no duration yet) and when
 * `durationMs` is undefined (legacy stream events from a session that
 * predates the per-tool timer instrumentation).
 */
function ToolDurationBadge({ durationMs }: { durationMs?: number }) {
  if (typeof durationMs !== "number") return null;
  const label = formatToolDuration(durationMs);
  if (!label) return null;
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
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (typeof startedAt !== "number") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [startedAt]);
  if (typeof startedAt !== "number") return null;
  const elapsed = Math.max(0, now - startedAt);
  const label = formatToolDuration(elapsed);
  if (!label) return null;
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums opacity-70"
      title={`${elapsed} ms (실행 중)`}
      data-testid="tool-duration-running"
      aria-live="polite"
    >
      ⏱ {label}
    </span>
  );
}

function formatToolPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.stringify(expandJsonStrings(JSON.parse(trimmed)), null, 2);
  } catch {
    return value;
  }
}

function expandJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try {
      return expandJsonStrings(JSON.parse(trimmed), depth + 1);
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandJsonStrings(item, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandJsonStrings(item, depth + 1)]),
    );
  }
  return value;
}

/** Single-tool inline indicator — no collapsible wrapper */
function SingleToolInline({
  tool,
  sessionId,
}: {
  tool: Extract<ChatEntry, { kind: "tool_group" }>["tools"][number];
  sessionId?: string;
}) {
  const isRunning = tool.status === "running";
  const isError = tool.status === "error";
  const [open, setOpen] = useState(false);
  const [scriptAllowed, setScriptAllowed] = useState(false);

  // Stub result — render collapsible CompactedToolResult instead of raw block.
  // Compaction marks tool_results by role+length, independent of error status,
  // so error tool_results can also be stubs.
  const isStubResult =
    !isRunning &&
    typeof tool.result === "string" &&
    tool.result.startsWith("[tool_result stripped:");

  if (isStubResult && sessionId) {
    return (
      <CompactedToolResult
        toolUseId={tool.toolUseId}
        toolName={getToolDisplayName(tool.name)}
        input={tool.input}
        stubContent={tool.result as string}
        sessionId={sessionId}
      />
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
      <WriteFileSidecarDiff
        resultJson={tool.result as string}
        sessionId={sessionId}
        toolUseId={tool.toolUseId}
        filePath={typeof tool.input?.path === "string" ? tool.input.path : undefined}
      />
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
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="min-w-0 truncate font-medium">{getToolDisplayName(tool.name)}</span>
        {isRunning
          ? <RunningDurationBadge startedAt={tool.startedAt} />
          : <ToolDurationBadge durationMs={tool.durationMs} />}
        {isRunning ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Badge variant={isError ? "secondary" : "default"} className={`shrink-0 px-1 py-0 text-[10px] ${isError ? "text-destructive" : ""}`}>
            {isError ? "실패" : "완료"}
          </Badge>
        )}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-1.5 font-mono text-[10px] lvis-anim-fade-in">
          {tool.input && (
            <div>
              <div className="mb-0.5 text-[9px] uppercase opacity-60">입력</div>
              <ToolPayloadBlock value={JSON.stringify(tool.input, null, 2)} />
            </div>
          )}
          {tool.result !== undefined && (
            <div>
              <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${isError ? "text-destructive" : ""}`}>{isError ? "오류" : "결과"}</div>
              <ToolPayloadBlock value={tool.result} isError={isError} />
            </div>
          )}
        </div>
      )}
      {htmlPayload && (
        <div className="space-y-2 border-t px-3 py-2">
          {htmlNeedsJavaScript && (
            <div className="flex items-center justify-between gap-3 rounded border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
              <span>이 HTML은 JavaScript가 필요할 수 있습니다. 실행을 허용할까요?</span>
              <Button
                type="button"
                size="sm"
                variant={scriptAllowed ? "secondary" : "outline"}
                onClick={() => setScriptAllowed((v) => !v)}
              >
                {scriptAllowed ? "JavaScript 차단" : "JavaScript 허용"}
              </Button>
            </div>
          )}
          <HtmlPreview payload={htmlPayload} allowScripts={scriptAllowed} />
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
}: {
  group: Extract<ChatEntry, { kind: "tool_group" }>;
  embedded?: boolean;
  /** Active session id for verbatim IPC fetch. When provided, stub results render as CompactedToolResult. */
  sessionId?: string;
}) {
  // All hooks must be declared before any conditional return (Rules of Hooks)
  const tools = [...group.tools].sort((a, b) => a.displayOrder - b.displayOrder);
  const [open, setOpen] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(() => new Set());
  const [scriptAllowed, setScriptAllowed] = useState<Set<string>>(new Set());

  // Single tool: render inline without group wrapper
  if (group.tools.length === 1 && group.tools[0]) {
    return <SingleToolInline tool={group.tools[0]} sessionId={sessionId} />;
  }
  const doneCount = group.tools.filter((t) => t.status !== "running").length;
  const hasError = group.tools.some((t) => t.status === "error");
  const groupStatus = group.status === "running"
    ? "running"
    : hasError ? "error" : "done";
  const groupTitle = groupStatus === "running" ? "도구 사용 중" : "도구 사용 결과";
  function toggleTool(id: string) {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const uniqueToolNames = [...new Set(tools.map((t) => getToolDisplayName(t.name)))].join(" · ");
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
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 hover:bg-muted/30"
        onClick={() => setOpen((o) => !o)}
      >
        <Wrench className="h-3 w-3 flex-shrink-0" />
        <span className="shrink-0 font-medium">{groupTitle}</span>
        <span className="min-w-0 truncate text-[10px] opacity-60">{uniqueToolNames}</span>
        <Badge variant="outline" className="px-1 py-0 text-[10px] flex-shrink-0">
          {groupStatus === "running" ? `${doneCount}/${group.tools.length}` : `${group.tools.length}개`}
        </Badge>
        {groupStatus === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin flex-shrink-0" />
        ) : (
          <Badge
            variant={groupStatus === "error" ? "secondary" : "default"}
            className={`px-1 py-0 text-[10px] flex-shrink-0 ${groupStatus === "error" ? "text-destructive" : ""}`}
          >
            {groupStatus === "error" ? "오류 있음" : "완료"}
          </Badge>
        )}
        {open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />}
      </button>
      {open && (
        <div className="min-w-0 space-y-1 border-t px-3 py-1.5 lvis-anim-fade-in">
          {tools.map((tool) => {
            const isExpanded = expandedTools.has(tool.toolUseId);
            return (
              <div key={tool.toolUseId} className="min-w-0 rounded border border-dashed/50">
                <button
                  className="flex w-full min-w-0 items-center gap-2 px-2 py-1 hover:bg-muted/20"
                  onClick={() => toggleTool(tool.toolUseId)}
                >
                  {isExpanded ? <ChevronDown className="h-2.5 w-2.5 flex-shrink-0" /> : <ChevronRight className="h-2.5 w-2.5 flex-shrink-0" />}
                  <span className="min-w-0 truncate">{getToolDisplayName(tool.name)}</span>
                  {tool.status === "running"
                    ? <RunningDurationBadge startedAt={tool.startedAt} />
                    : <ToolDurationBadge durationMs={tool.durationMs} />}
                  {tool.status === "running" ? (
                    <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />
                  ) : (
                    <Badge
                      variant={tool.status === "error" ? "secondary" : "default"}
                      className={`shrink-0 px-1 py-0 text-[10px] ${tool.status === "error" ? "text-destructive" : ""}`}
                    >
                      {tool.status === "error" ? "실패" : "완료"}
                    </Badge>
                  )}
                </button>
                {isExpanded && (
                  <div className="min-w-0 space-y-1 border-t px-2 py-1 font-mono text-[10px] lvis-anim-fade-in">
                    {tool.input && (
                      <div>
                        <div className="mb-0.5 text-[9px] uppercase opacity-60">입력</div>
                        <ToolPayloadBlock value={JSON.stringify(tool.input, null, 2)} />
                      </div>
                    )}
                    {tool.result !== undefined && (
                      <div>
                        <div className={`mb-0.5 text-[9px] uppercase opacity-60 ${tool.status === "error" ? "text-destructive" : ""}`}>
                          {tool.status === "error" ? "오류" : "결과"}
                        </div>
                        {/* Stub results render as collapsible CompactedToolResult. */}
                        {tool.result.startsWith("[tool_result stripped:") && sessionId ? (
                          <CompactedToolResult
                            toolUseId={tool.toolUseId}
                            toolName={getToolDisplayName(tool.name)}
                            input={tool.input}
                            stubContent={tool.result}
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
              {previewNeedsJavaScript(p.payload) && (
                <div className="flex items-center justify-between gap-3 rounded border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                  <span>이 HTML은 JavaScript가 필요할 수 있습니다. 실행을 허용할까요?</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={scriptAllowed.has(p.toolUseId) ? "secondary" : "outline"}
                    onClick={() => {
                      setScriptAllowed((prev) => {
                        const next = new Set(prev);
                        if (next.has(p.toolUseId)) next.delete(p.toolUseId);
                        else next.add(p.toolUseId);
                        return next;
                      });
                    }}
                  >
                    {scriptAllowed.has(p.toolUseId) ? "JavaScript 차단" : "JavaScript 허용"}
                  </Button>
                </div>
              )}
              <HtmlPreview
                payload={p.payload}
                allowScripts={scriptAllowed.has(p.toolUseId)}
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
