/**
 * TokenCostBadge — turn-aggregate 토큰/비용 토글 배지.
 *
 * 클릭하면 토큰 합계 ↔ 추정 비용 사이를 토글. hover 시 fresh / cache read /
 * cache write / output breakdown 을 tooltip 으로 노출. 데이터는 모두
 * provider 보고 값 (turn_summary entry → conversation-loop onTurnSummary).
 *
 * 토큰 수치 정의:
 *   - `freshInputTokens` = turn 전체 fresh input 합산 (cache read/write 제외).
 *     billing 가중치 (full input price) 가 그대로 적용되는 부분.
 *   - `tokensOut` = turn 전체 output 합산.
 *   - `cacheReadTokens`, `cacheWriteTokens` = turn 전체 cache 합산.
 *   - `tokensIn` = 마지막 라운드의 raw input (= fresh + cache, 컨텍스트 윈도우
 *     fill 표시용 — TokenProgressRing 이 사용. 이 배지에서는 tooltip 의
 *     "context (last)" 보조 정보로만 노출).
 *
 * Headline = `freshInputTokens + tokensOut` — 사용자가 "이번 턴에 어떤 일이
 * 일어났나" 를 가장 잘 보여주는 단일 수치. 캐시 read 는 가중치가 1/10 이라
 * headline 에 더하면 직관에 어긋남 (e.g. 100k 캐시 hit 으로 "100k 토큰 사용"
 * 보이면 사용자가 비용을 과대 추정).
 *
 * `pricing` 이 없으면 cost 모드 자체를 표시하지 않는다 (토글 비활성).
 * 잘못된 비용을 보여주느니 비용 표시를 안 하는 쪽이 정직.
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
  /** Last-round raw input tokens (includes cache reads). Tooltip-only here;
   *  TokenProgressRing reads this from turn_summary directly for context fill. */
  tokensIn: number;
  /** Turn-aggregate fresh input — billing weight, drives headline + cost. */
  freshInputTokens: number;
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
  freshInputTokens,
  tokensOut,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  pricing,
}: TokenCostBadgeProps) {
  // Default = tokens. 사용자 요청: 청구액보다 토큰 수치가 더 직관적.
  // 클릭으로 cost 토글 가능 (pricing 이 있을 때만).
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const headlineTokens = freshInputTokens + tokensOut;
  if (headlineTokens === 0 && tokensIn === 0) return null;

  const cost = pricing
    ? (freshInputTokens * pricing.inputPer1M +
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
          aria-label={showCostMode ? "추정 비용 (클릭: 토큰 표시)" : "fresh + output 토큰 (클릭: 비용 표시)"}
        >
          {showCostMode ? (
            <span className="text-emerald-600 dark:text-emerald-400">≈ {formatCost(cost!)}</span>
          ) : (
            <span>🪙 {formatTokens(headlineTokens)}</span>
          )}
          {cost !== null && <span className="text-[8px] opacity-50">⇅</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs tabular-nums">
        <div className="text-[10px] uppercase tracking-wider opacity-60 mb-1">turn breakdown</div>
        <div className="space-y-0.5">
          <div className="flex justify-between gap-3">
            <span>fresh in (1.0×):</span>
            <span>{freshInputTokens.toLocaleString()}</span>
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
          <div className="flex justify-between gap-3 font-semibold">
            <span>fresh + output:</span>
            <span>{headlineTokens.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-3 opacity-70">
            <span>context (last round):</span>
            <span>{tokensIn.toLocaleString()}</span>
          </div>
          {cost !== null && (
            <div className="flex justify-between gap-3 font-semibold text-emerald-500 pt-0.5 border-t border-border/40">
              <span>≈ cost:</span>
              <span>{formatCost(cost)}</span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
