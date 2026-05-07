/**
 * TokenCostBadge — turn-aggregate 토큰/비용 토글 배지.
 *
 * 사용자가 클릭하면 토큰 합계 ↔ 추정 비용 사이를 토글하고, hover 시
 * fresh / cache read / cache write / output 의 분리 breakdown 을 tooltip
 * 으로 보여준다. Anthropic prompt cache 가중치 (read 0.1× / write 1.25×)
 * 를 적용해 *billable equivalent* 비용 산출.
 *
 * 데이터 source 는 conversation-loop 의 `onTurnSummary` 에서 흘러오는
 * provider 보고 값 (chars/4 추정 아님). pricing 정보는 호출자가 prop
 * 으로 전달하며 미지정 시 Sonnet 기본값으로 fallback (대략치). Phase 3
 * 에서 active model 의 정확 pricing 으로 교체 예정.
 *
 * Reference: Kilo Code OpenCode session.ts:354-392 — fresh = inputTokens
 * − cacheRead − cacheWrite, cost = sum(component × per-component-rate).
 */
import { useState } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

export interface TokenCostBadgePricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Anthropic 표준: cache read 는 input 의 10%. 미지정 시 inputPer1M × 0.1. */
  cacheReadPer1M?: number;
  /** Anthropic 표준: cache write 는 input 의 125%. 미지정 시 inputPer1M × 1.25. */
  cacheWritePer1M?: number;
}

const DEFAULT_PRICING: TokenCostBadgePricing = {
  inputPer1M: 3,
  outputPer1M: 15,
};

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

  const p = pricing ?? DEFAULT_PRICING;
  const inP = p.inputPer1M;
  const outP = p.outputPer1M;
  const crP = p.cacheReadPer1M ?? inP * 0.1;
  const cwP = p.cacheWritePer1M ?? inP * 1.25;

  // Vercel AI SDK v6: inputTokens 는 cached 포함 정규화이므로 fresh 만
  // 분리해서 정상 가격 적용 (Kilo Code session.ts:355 패턴).
  const freshIn = Math.max(0, tokensIn - cacheReadTokens - cacheWriteTokens);

  const cost =
    (freshIn * inP +
      cacheReadTokens * crP +
      cacheWriteTokens * cwP +
      tokensOut * outP) /
    1_000_000;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setMode((m) => (m === "tokens" ? "cost" : "tokens"));
          }}
          className="inline-flex items-center gap-1 rounded border border-border/40 bg-muted/30 px-1.5 py-0.5 text-[10px] cursor-pointer hover:bg-muted/60 transition-colors tabular-nums"
          aria-label={mode === "tokens" ? "토큰 합계 — 클릭하여 비용으로 전환" : "추정 비용 — 클릭하여 토큰으로 전환"}
        >
          {mode === "tokens" ? (
            <span>🪙 {formatTokens(total)}</span>
          ) : (
            <span className="text-emerald-600 dark:text-emerald-400">≈ {formatCost(cost)}</span>
          )}
          <span className="text-[8px] opacity-50">⇅</span>
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
          <div className="flex justify-between gap-3 font-semibold text-emerald-500">
            <span>≈ cost:</span>
            <span>{formatCost(cost)}</span>
          </div>
        </div>
        <div className="mt-1 text-[10px] opacity-60 leading-relaxed">
          Anthropic 캐시: read 90% 할인 / write 25% 가산. 비용은 추정치.
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
