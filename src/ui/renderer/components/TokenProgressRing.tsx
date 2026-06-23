import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatCostBadge, type EstimateBreakdown } from "../../../lib/cost-estimator.js";

interface TokenProgressRingProps {
  used: number;
  budget: number;
  contextBudget?: number;
  tpmLimit?: number;
  /**
   * Cost estimate for the next request. Rendered inside the click-detail
   * popover as part of the single flat usage surface — there is no separate
   * cost badge sibling in the action row (the amount lives behind the ring,
   * revealed on click).
   */
  costEstimate?: EstimateBreakdown;
  /** Color class for the cost line, mirrors the former badge's tier color. */
  costClass?: string;
}

/**
 * TokenProgressRing — square SVG circular progress indicator for token usage.
 *
 * Interaction model:
 *   - HOVER → a tooltip showing the usage percent ONLY.
 *   - CLICK → a popover with the full usage breakdown plus the cost/amount,
 *     rendered as a single flat surface (no box-in-box).
 *
 * Color tiers: emerald < 50%, amber 50-80%, rose > 80%. Sized square at 26px
 * to match the sibling toolbar buttons (h-[26px] w-[26px]).
 */
export function TokenProgressRing({
  used,
  budget,
  contextBudget,
  tpmLimit,
  costEstimate,
  costClass,
}: TokenProgressRingProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));
  const displayBudget = Math.max(0, budget);
  const remaining = Math.max(0, displayBudget - used);
  const contextPct =
    typeof contextBudget === "number" && contextBudget > 0
      ? Math.min(100, Math.round((used / contextBudget) * 100))
      : pct;
  const tpmPct =
    typeof tpmLimit === "number" && tpmLimit > 0
      ? Math.min(100, Math.round((used / tpmLimit) * 100))
      : undefined;
  const isTpmBound = typeof tpmLimit === "number" && tpmLimit > 0 && tpmLimit < (contextBudget ?? Number.POSITIVE_INFINITY);

  const radius = 9;
  const strokeWidth = 2.5;
  const size = 26; // square, matches sibling h-[26px] w-[26px] buttons
  const cx = size / 2;
  const circumference = 2 * Math.PI * radius;
  const fillOffset = circumference * (1 - pct / 100);

  const strokeColor =
    pct < 50
      ? "hsl(var(--success))"
      : pct < 80
        ? "hsl(var(--warning))"
        : "hsl(var(--destructive))";

  const ring = (
    <button
      type="button"
      className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-input-bar hover:bg-muted/(--opacity-strong) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1"
      data-testid="token-progress-ring"
      title={t("tokenProgressRing.projectedInputTitle")}
      aria-label={`Projected input ${pct} percent`}
      role="img"
      tabIndex={0}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden
      >
        {/* Background track */}
        <circle
          cx={cx}
          cy={cx}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted-foreground/(--opacity-muted)"
        />
        {/* Foreground fill */}
        <circle
          cx={cx}
          cy={cx}
          r={radius}
          fill="none"
          stroke={strokeColor}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={fillOffset}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 300ms ease" }}
        />
      </svg>
    </button>
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{ring}</PopoverTrigger>
        </TooltipTrigger>
        {/* HOVER: percent only. */}
        <TooltipContent side="top" className="tabular-nums" data-testid="token-progress-ring-hint">
          {pct}%
        </TooltipContent>
      </Tooltip>

      {/* CLICK: full breakdown + cost, one flat surface. */}
      <PopoverContent
        side="top"
        align="start"
        className="min-w-[220px] p-3 text-xs tabular-nums"
        data-testid="token-progress-ring-detail"
      >
        <div className="mb-1 text-[10px] uppercase tracking-wider opacity-60">projected input</div>
        <div className="space-y-0.5">
          <div className="flex justify-between gap-3">
            <span>next request:</span>
            <span>{used.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>{isTpmBound ? "effective limit (TPM):" : "effective limit:"}</span>
            <span>{displayBudget.toLocaleString()}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span>remaining:</span>
            <span>{remaining.toLocaleString()}</span>
          </div>
        </div>
        <div className="mt-1 border-t border-border/(--opacity-medium) pt-1 space-y-0.5">
          <div className="flex justify-between gap-3 font-semibold">
            <span>usage:</span>
            <span>{pct}%</span>
          </div>
          {typeof contextBudget === "number" && contextBudget > 0 && contextBudget !== displayBudget && (
            <div className="flex justify-between gap-3 opacity-70">
              <span>context window:</span>
              <span>{contextBudget.toLocaleString()} ({contextPct}%)</span>
            </div>
          )}
          {typeof tpmPct === "number" && (
            <div className={`flex justify-between gap-3 ${isTpmBound ? "text-warning" : "opacity-70"}`}>
              <span>TPM:</span>
              <span>{tpmLimit!.toLocaleString()} ({tpmPct}%)</span>
            </div>
          )}
        </div>
        {costEstimate !== undefined && (
          <div className="mt-1 border-t border-border/(--opacity-medium) pt-1 space-y-0.5" data-testid="token-progress-ring-cost">
            <div className="flex justify-between gap-3">
              <span>{t("chatView.costInputLabel")}</span>
              <span>
                {costEstimate.inputTokens.toLocaleString()} tok
                {costEstimate.pricingKnown === false ? "" : ` · $${costEstimate.inputCost.toFixed(5)}`}
              </span>
            </div>
            <div className="flex justify-between gap-3">
              <span>{t("chatView.costOutputLabel")}</span>
              <span>
                {costEstimate.outputTokens.toLocaleString()} tok
                {costEstimate.pricingKnown === false ? "" : ` · $${costEstimate.outputCost.toFixed(5)}`}
              </span>
            </div>
            {costEstimate.pricingKnown === false ? (
              <div className="font-semibold">{t("chatView.costUnknownModel")}</div>
            ) : (
              <div className={`flex justify-between gap-3 font-semibold ${costClass ?? ""}`}>
                <span>{t("chatView.costTotalLabel")}</span>
                <span>{formatCostBadge(costEstimate.total, costEstimate.pricingKnown)}</span>
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
