import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

interface TokenProgressChipProps {
  used: number;
  budget: number;
}

export function TokenProgressChip({ used, budget }: TokenProgressChipProps) {
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));

  const tier =
    pct < 50
      ? { fill: "bg-emerald-500/40", text: "text-emerald-700 dark:text-emerald-300", border: "border-emerald-500/30" }
      : pct < 80
        ? { fill: "bg-amber-500/40", text: "text-amber-700 dark:text-amber-300", border: "border-amber-500/30" }
        : { fill: "bg-rose-500/40", text: "text-rose-700 dark:text-rose-300", border: "border-rose-500/30" };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={`relative flex h-5 min-w-[60px] items-center overflow-hidden rounded-full border bg-muted/50 px-2.5 font-mono text-[10px] tabular-nums ${tier.text} ${tier.border}`}
          data-testid="token-progress-chip"
          aria-label={`Token usage ${pct} percent`}
        >
          <div
            className={`absolute inset-y-0 left-0 ${tier.fill} transition-[width] duration-300`}
            style={{ width: `${pct}%` }}
            aria-hidden
          />
          <span className="relative z-10 mx-auto">{pct}%</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <span className="font-mono text-xs">
          {used.toLocaleString()} / {budget.toLocaleString()} tokens ({pct}%)
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
