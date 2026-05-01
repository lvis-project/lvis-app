import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";

interface TokenProgressRingProps {
  used: number;
  budget: number;
}

/**
 * TokenProgressRing — SVG circular progress indicator for token usage.
 *
 * Visual-only ring (no percent text inside). Raw counts revealed via hover
 * tooltip. Color tiers match the former chip: emerald < 50%, amber 50-80%,
 * rose > 80%. Sized at 26px to align with Warp-style toolbar buttons.
 */
export function TokenProgressRing({ used, budget }: TokenProgressRingProps) {
  const pct = Math.min(100, Math.round((used / Math.max(1, budget)) * 100));

  const radius = 10;
  const strokeWidth = 2.5;
  const size = (radius + strokeWidth) * 2; // 25px
  const circumference = 2 * Math.PI * radius;
  const fillOffset = circumference * (1 - pct / 100);

  const strokeColor =
    pct < 50
      ? "var(--color-emerald-500, #10b981)"
      : pct < 80
        ? "var(--color-amber-500, #f59e0b)"
        : "var(--color-rose-500, #f43f5e)";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center justify-center rounded-md p-1 hover:bg-muted/60 transition-colors cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-1"
          style={{ width: 28, height: 28 }}
          data-testid="token-progress-ring"
          aria-label={`Token usage ${pct} percent`}
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
              className="text-muted-foreground/30"
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
      <TooltipContent side="bottom">
        <span className="font-mono text-xs">
          {used.toLocaleString()} / {budget.toLocaleString()} tokens ({pct}%)
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
