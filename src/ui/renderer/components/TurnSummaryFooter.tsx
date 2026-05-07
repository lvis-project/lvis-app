import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatDuration, formatTokens } from "../../../lib/turn-summary-format.js";

/**
 * Aggregate one-line footer rendered under the final assistant card of a
 * completed turn. Displays:
 *   - step count (number of tool calls in the turn)
 *   - wall-clock duration (turn end − turn start)
 *   - token usage (in / out, summed) sourced from the LLM provider's
 *     usage report — see `engine/llm/vercel/stream-mapper.ts` which
 *     forwards prompt_tokens + completion_tokens.
 *
 * When per-tool `breakdown` is present, the row is clickable to expand
 * a per-tool slice (count + cumulative ms per tool name). Companion to
 * per-tool duration rendered on `ToolGroupCard`; this footer aggregates
 * them so users can spot search loops, expensive sub-agent delegations,
 * and token-heavy turns at a glance.
 *
 * `cumulativeToolMs === 0` means the executor hasn't yet been
 * instrumented with `durationMs` (companion PR
 * `feat/tool-execution-duration-display`); in that case the footer
 * elides the per-tool ms slice rather than reporting a misleading 0.
 */
export interface TurnSummaryFooterProps {
  turnDurationMs: number;
  toolCount: number;
  cumulativeToolMs: number;
  tokensIn: number;
  tokensOut: number;
  breakdown?: Record<string, { count: number; ms: number }>;
}

export function TurnSummaryFooter(props: TurnSummaryFooterProps) {
  const { turnDurationMs, toolCount, cumulativeToolMs, tokensIn, tokensOut, breakdown } = props;
  const [expanded, setExpanded] = useState(false);

  const totalTokens = Math.max(0, tokensIn) + Math.max(0, tokensOut);
  const breakdownEntries = breakdown ? Object.entries(breakdown) : [];
  // Surface the heaviest tools first — same intent as the §usage-stats
  // perVendor sort: cost (here ms) descending, with count as a stable
  // tiebreaker so deterministic rendering survives identical timings.
  breakdownEntries.sort((a, b) => b[1].ms - a[1].ms || b[1].count - a[1].count);
  const hasBreakdown = breakdownEntries.length > 0;
  const showCumulativeMs = cumulativeToolMs > 0;
  const stepWord = toolCount === 1 ? "step" : "steps";

  // Compute column widths for the expanded breakdown so the count and
  // ms columns align across rows even when tool names vary in length.
  const maxNameLen = breakdownEntries.reduce((max, [name]) => Math.max(max, name.length), 0);

  return (
    <div
      data-testid="turn-summary-footer"
      className="flex w-full max-w-full flex-col gap-1 px-3 pt-1 text-[11px] text-muted-foreground"
    >
      <button
        type="button"
        onClick={() => hasBreakdown && setExpanded((v) => !v)}
        className={`flex items-center gap-2 text-left ${hasBreakdown ? "cursor-pointer hover:text-foreground transition-colors" : "cursor-default"}`}
        aria-expanded={hasBreakdown ? expanded : undefined}
        aria-label="턴 요약"
        data-testid="turn-summary-footer-toggle"
      >
        {hasBreakdown ? (
          expanded ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )
        ) : null}
        <span data-testid="turn-summary-steps">
          {toolCount} {stepWord}
        </span>
        <span aria-hidden="true">·</span>
        <span data-testid="turn-summary-duration" title="턴 전체 소요 시간">
          {"⏱ "}
          {formatDuration(turnDurationMs)}
        </span>
        {showCumulativeMs ? (
          <span
            className="text-muted-foreground/70"
            data-testid="turn-summary-tools-duration"
            title="도구 누적 시간"
          >
            ({formatDuration(cumulativeToolMs)} tools)
          </span>
        ) : null}
        <span aria-hidden="true">·</span>
        <span data-testid="turn-summary-tokens" title="LLM provider usage report 기반 토큰">
          {"🪙 "}
          {formatTokens(totalTokens)} tokens
          {totalTokens > 0 ? (
            <span className="text-muted-foreground/70">
              {" "}
              ({formatTokens(tokensIn)} in / {formatTokens(tokensOut)} out)
            </span>
          ) : null}
        </span>
      </button>
      {expanded && hasBreakdown ? (
        <div
          data-testid="turn-summary-breakdown"
          className="ml-5 flex flex-col gap-0.5 font-mono text-[10.5px] text-muted-foreground/80"
        >
          {breakdownEntries.map(([name, slice]) => (
            <div key={name} className="flex items-baseline gap-3" data-testid={`turn-summary-breakdown-row:${name}`}>
              <span
                className="truncate"
                style={{ minWidth: `${Math.min(maxNameLen, 24)}ch`, display: "inline-block" }}
              >
                {name}
              </span>
              <span className="tabular-nums">×{String(slice.count).padStart(2, " ")}</span>
              <span className="tabular-nums">{"⏱ "}{formatDuration(slice.ms)}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
