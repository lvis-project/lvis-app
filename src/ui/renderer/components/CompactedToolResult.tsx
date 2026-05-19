/**
 * CompactedToolResult
 *
 * Renders a compacted (stub) tool result as a collapsible 1-line row.
 * Clicking fetches the verbatim content via IPC (in-session only).
 *
 * Four display states:
 *   collapsed — ▶ 📦 ToolName(input) · origLen chars  [펼치기]
 *               (origLen parsed from stub via `/origLen=(\d+)/` — server-side
 *               `compactedAt` field is metadata only and not rendered)
 *   loading   — ⋯ 📦 ToolName(input) · [불러오는 중…]  (IPC in-flight)
 *   expanded  — ▼ 📦 ToolName(input) · N줄  [접기] + line-numbered body
 *   missing   — ▸ 📦 ToolName(input) · 원본 소실 ⓘ  (disabled, restart 후)
 */

import { useState } from "react";
import { getApi } from "../api-client.js";

/** Lazily split content into at most `limit` lines without scanning the full string. */
function splitLines(content: string, limit: number): { lines: string[]; truncated: boolean } {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < limit) {
    const idx = content.indexOf("\n", start);
    if (idx === -1) {
      lines.push(content.slice(start));
      return { lines, truncated: false };
    }
    lines.push(content.slice(start, idx));
    start = idx + 1;
  }
  const truncated = start < content.length;
  return { lines, truncated };
}

/** Truncate tool input to a short display string. */
function truncateInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  // Show first key=value pair, cut at 48 chars
  const first = keys[0];
  const val = String(input[first] ?? "");
  const pair = `${first}=${val}`;
  return pair.length > 48 ? pair.slice(0, 45) + "…" : pair;
}

/** Extract original char count from stub text for display fallback. */
function parseStubChars(stubContent: string): number | null {
  const m = stubContent.match(/(?:origLen|originalBytes)=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function formatChars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K chars`;
  return `${n} chars`;
}

export interface CompactedToolResultProps {
  /** tool_use_id that maps to the verbatim in main process history */
  toolUseId: string;
  /** Display name of the tool (e.g. "Read") */
  toolName: string;
  /** Original tool input, for short display in header */
  input?: Record<string, unknown>;
  /** Stub content — `[tool_result stripped: ...]` */
  stubContent: string;
  /** Active session id — passed to IPC for session guard */
  sessionId: string;
}

export function CompactedToolResult({
  toolUseId,
  toolName,
  input,
  stubContent,
  sessionId,
}: CompactedToolResultProps) {
  const [state, setState] = useState<"collapsed" | "loading" | "expanded" | "missing">(
    "collapsed",
  );
  const [verbatim, setVerbatim] = useState<{ content: string; lineCount: number } | null>(null);

  const inputStr = truncateInput(input);
  const origChars = parseStubChars(stubContent);

  async function handleExpand() {
    // cache hit — verbatim already fetched, skip IPC
    if (verbatim) {
      setState("expanded");
      return;
    }
    setState("loading");
    try {
      const result = await getApi().chatGetVerbatimToolResult(sessionId, toolUseId);
      if (result === null) {
        setState("missing");
      } else {
        setVerbatim(result);
        setState("expanded");
      }
    } catch (err) {
      console.error("chatGetVerbatimToolResult failed:", err);
      setState("missing");
    }
  }

  const headerLabel = inputStr ? `${toolName}(${inputStr})` : toolName;

  if (state === "expanded" && verbatim) {
    return (
      <div className="tool-result-expanded min-w-0 w-full max-w-full rounded-md text-[11px]">
        <button
          type="button"
          className="tre-header flex w-full min-w-0 items-center gap-1.5 px-3 py-1.5 text-left hover:bg-muted/30"
          style={{ color: "hsl(var(--action-compact))" }}
          onClick={() => setState("collapsed")}
        >
          <span>▼</span>
          <span>📦</span>
          <span className="min-w-0 truncate font-medium text-muted-foreground">{headerLabel}</span>
          <span className="shrink-0 text-muted-foreground/70">· {verbatim.lineCount}줄</span>
          <span className="ml-auto shrink-0 text-[10px] text-primary">접기</span>
        </button>
        <div className="tre-body min-w-0 rounded-b-md border-t max-h-[16rem] overflow-y-auto px-3 py-1 font-mono text-[10px] leading-[1.4]"
          style={{ backgroundColor: "hsl(var(--code-bg))", color: "hsl(var(--code-fg))" }}
        >
          {(() => {
            const MAX_DISPLAY_LINES = 1000;
            const { lines: displayLines, truncated } = splitLines(verbatim.content, MAX_DISPLAY_LINES);
            return (
              <div>
                {displayLines.map((line, i) => (
                  <div className="tre-line flex gap-2" key={i}>
                    <span className="tre-ln shrink-0 select-none text-muted-foreground/40 text-right w-7">{i + 1}</span>
                    <span className="tre-code whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0">{line}</span>
                  </div>
                ))}
                {truncated && (
                  <div className="tre-truncated px-2 py-1 text-muted-foreground/60 italic">
                    ⓘ 화면 표시 제한 ({MAX_DISPLAY_LINES} 줄)
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    );
  }

  if (state === "missing") {
    return (
      <div
        className="flex min-w-0 w-full max-w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] text-muted-foreground/50 cursor-default select-none"
        style={{ backgroundColor: "hsl(var(--muted) / 0.4)" }}
        title="원본은 in-session 동안만 사용 가능합니다. 재시작 후 verbatim이 소실되었습니다."
      >
        <span>▸</span>
        <span>📦</span>
        <span className="min-w-0 truncate">{headerLabel}</span>
        {origChars !== null && (
          <span className="shrink-0 opacity-70">· {formatChars(origChars)}</span>
        )}
        <span className="shrink-0 ml-1">· 원본 소실</span>
        <span className="shrink-0 text-[10px]" title="앱 재시작 후에는 원본을 복원할 수 없습니다.">ⓘ</span>
      </div>
    );
  }

  // collapsed (or loading)
  return (
    <button
      type="button"
      className="flex min-w-0 w-full max-w-full items-center gap-1.5 rounded-md px-3 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-60"
      style={{ backgroundColor: "hsl(var(--muted) / 0.4)" }}
      disabled={state === "loading"}
      onClick={() => { void handleExpand(); }}
    >
      <span style={{ color: "hsl(var(--action-compact))" }}>
        {state === "loading" ? "⋯" : "▶"}
      </span>
      <span>📦</span>
      <span className="min-w-0 truncate">{headerLabel}</span>
      {origChars !== null && (
        <span className="shrink-0 text-muted-foreground/70">· {formatChars(origChars)}</span>
      )}
      <span
        className="ml-auto shrink-0 text-[10px]"
        style={{ color: "hsl(var(--primary))" }}
      >
        {state === "loading" ? "불러오는 중…" : "[펼치기]"}
      </span>
    </button>
  );
}
