/**
 * TokenCostBadge — turn-aggregate 토큰/비용 토글 배지.
 *
 * 클릭하면 토큰 합계 ↔ 추정 비용 사이를 토글. hover 시 fresh / cache read /
 * cache write / output breakdown 을 tooltip 으로 노출. 데이터는 모두
 * provider 보고 값 (turn_summary entry → conversation-loop onTurnSummary).
 *
 * `pricing` 이 없으면 cost 모드 자체를 표시하지 않는다 (토글 비활성).
 * 잘못된 비용을 보여주느니 비용 표시를 안 하는 쪽이 정직 — 호출자가
 * pricing 을 wiring 하기 전까지는 token 만 표시.
 */
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export interface TokenCostBadgePricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Anthropic 기본: cache read = input 의 10%. 미지정 시 inputPer1M × 0.1. */
  cacheReadPer1M?: number;
  /** Anthropic 기본: cache write = input 의 125%. 미지정 시 inputPer1M × 1.25. */
  cacheWritePer1M?: number;
}

export interface TokenCostBadgeProps {
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  pricing?: TokenCostBadgePricing;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function formatCost(c: number): string {
  if (c <= 0) return "$0";
  if (c < 0.001) return `$${c.toFixed(5)}`;
  if (c < 0.01) return `$${c.toFixed(4)}`;
  if (c < 1) return `$${c.toFixed(3)}`;
  return `$${c.toFixed(2)}`;
}

export function TokenCostBadge({
  tokensIn,
  tokensOut,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  pricing,
}: TokenCostBadgeProps) {
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const total = tokensIn + tokensOut;
  if (total === 0) return null;

  // Vercel AI SDK v6 의 inputTokens 가 cached 까지 포함한 정규화 값 →
  // fresh 만 분리해야 정상 가격 적용. (Kilo OpenCode session.ts:355)
  const freshIn = Math.max(0, tokensIn - cacheReadTokens - cacheWriteTokens);

  const cost = pricing
    ? (freshIn * pricing.inputPer1M +
        cacheReadTokens * (pricing.cacheReadPer1M ?? pricing.inputPer1M * 0.1) +
        cacheWriteTokens * (pricing.cacheWritePer1M ?? pricing.inputPer1M * 1.25) +
        tokensOut * pricing.outputPer1M) /
      1_000_000
    : null;

  const showCostMode = mode === "cost" && cost !== null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (cost !== null) setMode((m) => (m === "tokens" ? "cost" : "tokens"));
          }}
          className={`inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] tabular-nums ${cost !== null ? "cursor-pointer hover:bg-muted/60" : "cursor-default"}`}
          aria-label={showCostMode ? "추정 비용 (클릭: 토큰 표시)" : "토큰 합계 (클릭: 비용 표시)"}
        >
          {showCostMode ? (
            <span className="text-emerald-600 dark:text-emerald-400">≈ {formatCost(cost!)}</span>
          ) : (
            <span>🪙 {formatTokens(total)}</span>
          )}
          {cost !== null && <span className="text-[8px] opacity-50">⇅</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs tabular-nums">
        <div className="text-[10px] uppercase tracking-wider opacity-60 mb-1">turn breakdown</div>
        <div className="space-y-0.5">
          <div className="flex justify-between gap-3">
            <span>fresh in (1.0×):</span>
            <span>{freshIn.toLocaleString()}</span>
          </div>
          {cacheReadTokens > 0 && (
            <div className="flex justify-between gap-3 text-emerald-500">
              <span>cache read (0.1×):</span>
              <span>{cacheReadTokens.toLocaleString()}</span>
            </div>
          )}
          {cacheWriteTokens > 0 && (
            <div className="flex justify-between gap-3 text-amber-500">
              <span>cache write (1.25×):</span>
              <span>{cacheWriteTokens.toLocaleString()}</span>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span>output:</span>
            <span>{tokensOut.toLocaleString()}</span>
          </div>
        </div>
        <div className="mt-1 border-t border-border/40 pt-1 space-y-0.5">
          <div className="flex justify-between gap-3">
            <span className="opacity-60">total tokens:</span>
            <span>{total.toLocaleString()}</span>
          </div>
          {cost !== null && (
            <div className="flex justify-between gap-3 font-semibold text-emerald-500">
              <span>≈ cost:</span>
              <span>{formatCost(cost)}</span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
