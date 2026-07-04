



import { memo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import {
  computeCost,
  lookupBillablePricingOptional,
  normalizeAiSdkUsageForCost,
  type ModelPricing,
} from "../../../shared/pricing-data.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";

export interface TokenCostBadgePricing {
  inputPer1M: number;
  outputPer1M: number;

  cacheReadPer1M?: number;

  cacheWritePer1M?: number;
}

export interface TokenCostBadgeProps {
  /** Turn-end projected context input. Tooltip-only here. */
  tokensIn: number;
  /** Turn-aggregate fresh input — billing weight, drives headline + cost. */
  freshInputTokens: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  pricing?: TokenCostBadgePricing;
  /**
   * Active vendor for the turn — selects how cache fields combine with the
   * cost formula. Mirrors the asymmetry encoded in
   * `engine/llm/pricing.ts:computeCost`:
   *   - "claude": cache is additive (Anthropic ratios applied).
   *   - everyone else: provider raw prompt_tokens includes cached tokens, so
   *     the badge reconstructs raw input as fresh + cache before calling the
   *     shared formula.
   * Optional for backward-compat in tests; production callers always
   * propagate the active vendor from ChatContext.
   */
  vendor?: LLMVendor;
  /**
   * Per provider request usage segments. When present, cost is summed per
   * segment so request-tier pricing such as OpenAI long-context surcharge is
   * not accidentally applied to an LVIS turn aggregate.
   */
  usageByModel?: Array<{
    vendorProvider: LLMVendor;
    vendorModel: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
  }>;
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

function TokenCostBadgeImpl({
  tokensIn,
  freshInputTokens,
  tokensOut,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
  pricing,
  vendor,
  usageByModel,
}: TokenCostBadgeProps) {
  // Default = tokens. 사용자 요청: 청구액보다 토큰 수치가 더 직관적.
  // 클릭으로 cost 토글 가능 (pricing 이 있을 때만).
  const { t } = useTranslation();
  const [mode, setMode] = useState<"tokens" | "cost">("tokens");
  const headlineTokens = freshInputTokens + tokensOut;
  if (headlineTokens === 0 && tokensIn === 0) return null;

  // Single source of truth for cost math — shared `computeCost` (browser-safe
  // via `shared/pricing-data.ts`) is the same function the engine billing
  // pipeline calls. Keeps the badge from drifting when vendor branches evolve.
  const effectiveVendor = vendor ?? "claude";
  const costInputTokens = effectiveVendor === "claude"
    ? freshInputTokens
    : freshInputTokens + cacheReadTokens + cacheWriteTokens;
  // `contextWindow` is irrelevant to the cost formula but `ModelPricing`
  // requires it structurally, so we pin a dummy 0 — computeCost never reads
  // it. Effective vendor defaults to "claude" for back-compat with tests that
  // omit the prop (production callers always propagate from ChatContext).
  const segmentCost = usageByModel && usageByModel.length > 0
    ? usageByModel.reduce<number | null>((sum, segment) => {
        if (sum === null) return null;
        const segmentPricing = lookupBillablePricingOptional(segment.vendorProvider, segment.vendorModel);
        if (!segmentPricing) return null;
        return sum + computeCost(
          normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
          segmentPricing,
          segment.vendorProvider,
        );
      }, 0)
    : undefined;
  const cost = segmentCost !== undefined
    ? segmentCost
    : pricing
    ? computeCost(
        {
          inputTokens: costInputTokens,
          outputTokens: tokensOut,
          cacheReadTokens,
          cacheWriteTokens,
        },
        { ...(pricing as ModelPricing), contextWindow: (pricing as Partial<ModelPricing>).contextWindow ?? 0 },
        effectiveVendor,
      )
    : null;

  const showCostMode = mode === "cost" && cost !== null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="token-cost-badge"
          onClick={(e) => {
            e.stopPropagation();
            if (cost !== null) setMode((m) => (m === "tokens" ? "cost" : "tokens"));
          }}
          className={`inline-flex items-center gap-1 rounded border border-border/(--opacity-medium) bg-muted/(--opacity-muted) px-1.5 py-0.5 text-[10px] tabular-nums ${cost !== null ? "cursor-pointer hover:bg-muted/(--opacity-strong)" : "cursor-default"}`}
          aria-disabled={cost === null}
          aria-label={
            cost === null
              ? t("tokenCostBadge.ariaLabelNoPricing")
              : showCostMode
                ? t("tokenCostBadge.ariaLabelCostMode")
                : t("tokenCostBadge.ariaLabelTokenMode")
          }
        >
          {showCostMode ? (
            <span className="text-success">≈ {formatCost(cost!)}</span>
          ) : (
            <>
              <span>🪙 {formatTokens(headlineTokens)}</span>
              {cost === null && <span className="text-muted-foreground">{t("tokenCostBadge.pricingUnknownBadge")}</span>}
            </>
          )}
          {cost !== null && <span className="text-[8px] opacity-50">⇅</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs tabular-nums">
        <div className="text-[10px] uppercase tracking-wider opacity-60 mb-1">{t("tokenCostBadge.breakdownTitle")}</div>
        <div className="space-y-0.5">
          <div className="flex justify-between gap-3">
            <span>{t("tokenCostBadge.freshInputLabel")}</span>
            <span>{freshInputTokens.toLocaleString()}</span>
          </div>
          {cacheReadTokens > 0 && (
            <div className="flex justify-between gap-3 text-success">
              <span>{t("tokenCostBadge.cacheReadLabel")}</span>
              <span>{cacheReadTokens.toLocaleString()}</span>
            </div>
          )}
          {cacheWriteTokens > 0 && (
            <div className="flex justify-between gap-3 text-warning">
              <span>{t("tokenCostBadge.cacheWriteLabel")}</span>
              <span>{cacheWriteTokens.toLocaleString()}</span>
            </div>
          )}
          <div className="flex justify-between gap-3">
            <span>{t("tokenCostBadge.outputLabel")}</span>
            <span>{tokensOut.toLocaleString()}</span>
          </div>
        </div>
        <div className="mt-1 border-t border-border/(--opacity-medium) pt-1 space-y-0.5">
          <div className="flex justify-between gap-3 font-semibold">
            <span>{t("tokenCostBadge.freshPlusOutputLabel")}</span>
            <span>{headlineTokens.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-3 opacity-70">
            <span>{t("tokenCostBadge.projectedNextInputLabel")}</span>
            <span>{tokensIn.toLocaleString()}</span>
          </div>
          {cost !== null && (
            <div className="flex justify-between gap-3 font-semibold text-success pt-0.5 border-t border-border/(--opacity-medium)">
              <span>{t("tokenCostBadge.estimatedCostLabel")}</span>
              <span>{formatCost(cost)}</span>
            </div>
          )}
          {cost === null && (
            <div className="flex justify-between gap-3 font-semibold text-muted-foreground pt-0.5 border-t border-border/(--opacity-medium)">
              <span>{t("tokenCostBadge.costLabel")}</span>
              <span>{t("tokenCostBadge.pricingUnknownLabel")}</span>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export const TokenCostBadge = memo(TokenCostBadgeImpl);
