import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { useTranslation } from "../../../i18n/react.js";

interface TokenProgressRingProps {
  used: number;
  budget: number;
  contextBudget?: number;
  tpmLimit?: number;
}

/**
 * TokenProgressRing — SVG circular progress indicator for token usage.
 *
 * Visual-only ring (no percent text inside). Projected request counts revealed via hover
 * tooltip. Color tiers match the former chip: emerald < 50%, amber 50-80%,
 * rose > 80%. Sized at 26px to align with Warp-style toolbar buttons.
 */
export function TokenProgressRing({ used, budget, contextBudget, tpmLimit }: TokenProgressRingProps) {
  const { t } = useTranslation();
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

  const radius = 10;
  const strokeWidth = 2.5;
  const size = (radius + strokeWidth) * 2; // 25px
  const circumference = 2 * Math.PI * radius;
  const fillOffset = circumference * (1 - pct / 100);

  const strokeColor =
    pct < 50
      ? "hsl(var(--success))"
      : pct < 80
        ? "hsl(var(--warning))"
        : "hsl(var(--destructive))";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center justify-center rounded-md p-1 hover:bg-muted/(--opacity-strong) transition-colors cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1"
          style={{ width: 28, height: 28 }}
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
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeWidth={strokeWidth}
              className="text-muted-foreground/(--opacity-muted)"
            />
            {/* Foreground fill */}
            <circle
              cx={size / 2}
              cy={size / 2}
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
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="min-w-[220px] text-xs tabular-nums">
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
      </TooltipContent>
    </Tooltip>
  );
}
