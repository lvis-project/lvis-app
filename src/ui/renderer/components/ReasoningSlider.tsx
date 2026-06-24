/**
 * ReasoningSlider — compact 4-step reasoning control for the composer status
 * sub-row (between the vendor·model cell and the online-status dot).
 *
 * Replaces the old on/off ThinkingButton + separate depth popover with a single
 * 4-step slider:
 *   0 = 추론 없음 (thinking off)
 *   1 = 낮음  (thinking on, 4k budget)
 *   2 = 중간  (thinking on, 10k budget)
 *   3 = 높음  (thinking on, 24k budget)
 *
 * On/off is host-owned (`enabled` / `onToggle`, persisted per-vendor). Depth is
 * self-contained: this reads/writes the active vendor's `thinkingBudgetTokens`
 * through the renderer api — the same self-contained pattern ThinkingButton used.
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { DEFAULT_LLM_VENDOR, isLLMVendor, type LLMVendor } from "../../../shared/llm-vendor-defaults.js";

type Depth = "low" | "medium" | "high";

const DEPTH_BUDGET: Record<Depth, number> = { low: 4_000, medium: 10_000, high: 24_000 };
const LEVEL_DEPTH: Record<1 | 2 | 3, Depth> = { 1: "low", 2: "medium", 3: "high" };
const DEPTH_LEVEL: Record<Depth, 1 | 2 | 3> = { low: 1, medium: 2, high: 3 };

function budgetToDepth(budget: number): Depth {
  let best: Depth = "medium";
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const d of ["low", "medium", "high"] as Depth[]) {
    const delta = Math.abs(DEPTH_BUDGET[d] - budget);
    if (delta < bestDelta) { best = d; bestDelta = delta; }
  }
  return best;
}

function narrowVendor(raw: unknown): LLMVendor {
  return isLLMVendor(raw) ? raw : DEFAULT_LLM_VENDOR;
}

export interface ReasoningSliderProps {
  /** Host-owned thinking on/off (persisted per-vendor). */
  enabled: boolean;
  onToggle: (next: boolean) => void | Promise<void>;
}

export function ReasoningSlider({ enabled, onToggle }: ReasoningSliderProps) {
  const { t } = useTranslation();
  const [depth, setDepth] = useState<Depth>("medium");

  // Seed the depth from the active vendor's persisted budget.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const s = await getApi().getSettings();
        const provider = narrowVendor(s.llm.provider);
        const budget = s.llm.vendors[provider]?.thinkingBudgetTokens;
        if (!cancelled && typeof budget === "number") setDepth(budgetToDepth(budget));
      } catch {
        /* keep default */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const persistDepth = useCallback(async (next: Depth) => {
    try {
      const api = getApi();
      const s = await api.getSettings();
      const provider = narrowVendor(s.llm.provider);
      await api.updateSettings({
        llm: { vendors: { [provider]: { thinkingBudgetTokens: DEPTH_BUDGET[next] } } },
      });
    } catch {
      /* best-effort; UI state already updated */
    }
  }, []);

  // Current 0–3 level: 0 when thinking is off; otherwise depth + 1.
  const level: 0 | 1 | 2 | 3 = enabled ? DEPTH_LEVEL[depth] : 0;

  const levelLabels = [
    t("bottomActionRow.reasoningNone"),
    t("bottomActionRow.thinkingDepthLow"),
    t("bottomActionRow.thinkingDepthMedium"),
    t("bottomActionRow.thinkingDepthHigh"),
  ];

  const apply = useCallback(
    (next: number) => {
      const lvl = Math.max(0, Math.min(3, Math.round(next))) as 0 | 1 | 2 | 3;
      if (lvl === 0) {
        if (enabled) void onToggle(false);
        return;
      }
      if (!enabled) void onToggle(true);
      const d = LEVEL_DEPTH[lvl as 1 | 2 | 3];
      setDepth(d);
      void persistDepth(d);
    },
    [enabled, onToggle, persistDepth],
  );

  const reasoningLabel = t("bottomActionRow.reasoning");
  return (
    <span
      className="flex shrink-0 items-center gap-1.5"
      data-testid="reasoning-slider"
      data-level={level}
    >
      <span className="shrink-0">{reasoningLabel}</span>
      <input
        type="range"
        min={0}
        max={3}
        step={1}
        value={level}
        onChange={(e) => apply(Number(e.target.value))}
        aria-label={`${reasoningLabel}: ${levelLabels[level]}`}
        title={`${reasoningLabel}: ${levelLabels[level]}`}
        className="lvis-reasoning-range h-1 w-14 shrink-0 cursor-pointer accent-primary"
      />
      <span className={`shrink-0 tabular-nums ${level > 0 ? "text-primary" : ""}`}>
        {levelLabels[level]}
      </span>
    </span>
  );
}
