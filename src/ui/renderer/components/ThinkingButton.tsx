/**
 * ThinkingButton — composer control for the "thinking" (extended reasoning)
 * mode. Lives in the action row, right-aligned just before Send.
 *
 *   - Click → popover.
 *   - Popover: an on/off toggle for thinking, plus a depth selector
 *     (Low / Medium / High) that maps to the active vendor's
 *     `thinkingBudgetTokens` (4k / 10k / 24k).
 *
 * On/off is owned by the host (`enabled` / `onToggle`, persisted per-vendor via
 * useSettings). Depth is self-contained: this component reads/writes the active
 * vendor's `thinkingBudgetTokens` directly through the renderer api (getApi),
 * so no extra prop threading is needed — the same self-contained pattern other
 * composer popovers use to load their own data.
 *
 * Replaces the old inline "Thinking" checkbox, which sat in the action bar with
 * no depth control. Moving it to a dedicated button before Send also keeps it
 * from overlapping other inline affordances.
 */
import { useCallback, useEffect, useState } from "react";
import { Brain } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Label } from "../../../components/ui/label.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { DEFAULT_LLM_VENDOR, isLLMVendor, type LLMVendor } from "../../../shared/llm-vendor-defaults.js";

type Depth = "low" | "medium" | "high";

/** Depth → per-vendor thinkingBudgetTokens. */
export const DEPTH_BUDGET: Record<Depth, number> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
};

const DEPTHS: { id: Depth; labelKey: string }[] = [
  { id: "low", labelKey: "bottomActionRow.thinkingDepthLow" },
  { id: "medium", labelKey: "bottomActionRow.thinkingDepthMedium" },
  { id: "high", labelKey: "bottomActionRow.thinkingDepthHigh" },
];

/** Closest depth bucket for a stored budget (handles legacy/custom values). */
function budgetToDepth(budget: number): Depth {
  let best: Depth = "medium";
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const d of ["low", "medium", "high"] as Depth[]) {
    const delta = Math.abs(DEPTH_BUDGET[d] - budget);
    if (delta < bestDelta) {
      best = d;
      bestDelta = delta;
    }
  }
  return best;
}

function narrowVendor(raw: unknown): LLMVendor {
  return isLLMVendor(raw) ? raw : DEFAULT_LLM_VENDOR;
}

export interface ThinkingButtonProps {
  enabled: boolean;
  onToggle: (next: boolean) => void | Promise<void>;
}

export function ThinkingButton({ enabled, onToggle }: ThinkingButtonProps) {
  const { t } = useTranslation();
  const [depth, setDepth] = useState<Depth>("medium");

  // Load the active vendor's current budget once so the popover opens on the
  // persisted depth rather than always "medium".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getApi().getSettings();
        const provider = narrowVendor(s.llm.provider);
        const budget = s.llm.vendors[provider]?.thinkingBudgetTokens;
        if (!cancelled && typeof budget === "number") setDepth(budgetToDepth(budget));
      } catch {
        /* keep the default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectDepth = useCallback(async (next: Depth) => {
    setDepth(next);
    try {
      const api = getApi();
      const s = await api.getSettings();
      const provider = narrowVendor(s.llm.provider);
      await api.updateSettings({
        llm: { vendors: { [provider]: { thinkingBudgetTokens: DEPTH_BUDGET[next] } } },
      });
    } catch {
      /* persistence best-effort; UI state already updated */
    }
  }, []);

  const label = t("bottomActionRow.thinking");

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="thinking-button"
              aria-pressed={enabled}
              className={`h-7 shrink-0 gap-1 px-2 text-[11px] font-medium ${
                enabled
                  ? "border-primary bg-primary/(--opacity-soft) text-primary"
                  : "bg-input-bar text-muted-foreground"
              }`}
            >
              <Brain className="h-3.5 w-3.5" />
              <span>{label}</span>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-56 p-3" data-testid="thinking-popover">
        <Label className="flex cursor-pointer select-none items-center gap-2 text-xs">
          <Checkbox
            className="size-3.5"
            checked={enabled}
            onCheckedChange={(checked) => void onToggle(checked === true)}
          />
          <span>{label}</span>
        </Label>

        <div className={`mt-3 ${enabled ? "" : "pointer-events-none opacity-50"}`}>
          <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("bottomActionRow.thinkingDepthLabel")}
          </div>
          <div className="flex gap-1" data-testid="thinking-depth-group">
            {DEPTHS.map(({ id, labelKey }) => (
              <button
                key={id}
                type="button"
                data-testid={`thinking-depth-${id}`}
                aria-pressed={depth === id}
                onClick={() => void selectDepth(id)}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] transition-colors ${
                  depth === id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background text-muted-foreground hover:bg-accent"
                }`}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
