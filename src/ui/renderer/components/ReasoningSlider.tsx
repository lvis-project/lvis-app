import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import {
  getLlmVendorSettings,
  narrowLlmVendor,
} from "../../../shared/llm-vendor-defaults.js";
import { REASONING_DEPTHS, budgetToDepthIndex } from "../constants.js";

type Depth = (typeof REASONING_DEPTHS)[number]["key"];

/**
 * Depth → the per-vendor `thinkingBudgetTokens` it persists as.
 *
 * Derived from the one ladder in constants rather than written out again: the
 * settings tab writes the same `thinkingBudgetTokens`, and a second copy of
 * these numbers is exactly how the two surfaces came to disagree about what a
 * stored budget meant. The budget is the stored value and the label only names
 * it, so a vendor already holding 24,000 keeps thinking exactly as deeply as
 * before and simply reads as the rung that budget now belongs to.
 */
export const DEPTH_BUDGET = Object.fromEntries(
  REASONING_DEPTHS.map((d) => [d.key, d.budget]),
) as Record<Depth, number>;

/** Level 0 is off, so a rung's level is its index in the ladder plus one. */
const LEVEL_DEPTH = REASONING_DEPTHS.map((d) => d.key);

function budgetToDepth(budget: number): Depth {
  return LEVEL_DEPTH[budgetToDepthIndex(budget)]!;
}

export interface ReasoningLevelOptions {
  /** Host-owned thinking on/off (persisted per-vendor). */
  enabled: boolean;
  onToggle: (next: boolean) => void | Promise<void>;
}

export type ReasoningLevel = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Top of the ladder. The slider's range, the clamp that pairs with it, the
 * labels and the gauge all count off `REASONING_DEPTHS`, so a rung added there
 * arrives in every one of them at once; the pair that could silently disagree
 * — a slider offering a level the clamp then throws away — cannot form. The
 * one thing still written out is `ReasoningLevel`, which the type system
 * checks against `REASONING_FILL` in the composer.
 */
const REASONING_LEVEL_MAX = REASONING_DEPTHS.length;

/**
 * The reasoning level as ONE value the composer's controls all read.
 *
 * Level 0 is thinking off; 1–5 are the depths, persisted per vendor as a
 * token budget. The depth follows the settings broadcast rather than a
 * one-time seed, because more than one surface shows it — the status-row
 * chip, the model card it opens, and every other tile's composer — and a
 * change made in any of them has to reach the rest.
 */
export function useReasoningLevel({ enabled, onToggle }: ReasoningLevelOptions): {
  level: ReasoningLevel;
  levelLabels: string[];
  apply: (next: number) => void;
} {
  const { t } = useTranslation();
  const [depth, setDepth] = useState<Depth>("medium");

  useEffect(() => {
    let cancelled = false;
    const seed = (llm: { provider: unknown; vendors: Parameters<typeof getLlmVendorSettings>[0] }) => {
      const budget = getLlmVendorSettings(llm.vendors, narrowLlmVendor(llm.provider)).thinkingBudgetTokens;
      if (!cancelled && typeof budget === "number") setDepth(budgetToDepth(budget));
    };
    let unsubscribe = () => {};
    try {
      const api = getApi();
      void api.getSettings().then((s) => seed(s.llm)).catch(() => { /* keep default */ });
      unsubscribe = api.onSettingsUpdated((s) => seed(s.llm));
    } catch {
      /* no api in this surface: keep default */
    }
    return () => { cancelled = true; unsubscribe(); };
  }, []);

  const persistDepth = useCallback(async (next: Depth) => {
    try {
      const api = getApi();
      const s = await api.getSettings();
      const provider = narrowLlmVendor(s.llm.provider);
      await api.updateSettings({
        llm: { vendors: { [provider]: { thinkingBudgetTokens: DEPTH_BUDGET[next] } } },
      });
    } catch {
      /* best-effort; UI state already updated */
    }
  }, []);

  const level: ReasoningLevel = enabled ? ((LEVEL_DEPTH.indexOf(depth) + 1) as ReasoningLevel) : 0;

  // The same names the settings tab shows, off the same ladder — the composer
  // used to carry its own copies, and in Korean they had already drifted
  // ("중간" here against "보통" there) for what is one setting.
  const levelLabels = [t("bottomActionRow.reasoningNone"), ...REASONING_DEPTHS.map((d) => d.label)];

  const apply = useCallback(
    (next: number) => {
      const lvl = Math.max(0, Math.min(REASONING_LEVEL_MAX, Math.round(next))) as ReasoningLevel;
      if (lvl === 0) {
        if (enabled) void onToggle(false);
        return;
      }
      if (!enabled) void onToggle(true);
      const d = LEVEL_DEPTH[lvl - 1]!;
      setDepth(d);
      void persistDepth(d);
    },
    [enabled, onToggle, persistDepth],
  );

  return { level, levelLabels, apply };
}

/** The range and its six labels — the same control wherever the level is set. */
export function ReasoningLevelControl({
  level,
  levelLabels,
  apply,
  label,
}: {
  level: ReasoningLevel;
  levelLabels: string[];
  apply: (next: number) => void;
  label: string;
}) {
  return (
    <>
      <input
        type="range"
        min={0}
        max={REASONING_LEVEL_MAX}
        step={1}
        value={level}
        onChange={(e) => apply(Number(e.target.value))}
        aria-label={`${label}: ${levelLabels[level]}`}
        className="lvis-reasoning-range h-1 w-full cursor-pointer accent-primary"
        data-testid="reasoning-range"
      />
      <div className="mt-1.5 flex justify-between text-micro text-muted-foreground">
        {levelLabels.map((text, idx) => (
          <button
            key={text}
            type="button"
            onClick={() => apply(idx)}
            className={`shrink-0 cursor-pointer transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:text-foreground motion-reduce:transition-none ${
              idx === level ? "font-medium text-primary" : ""
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </>
  );
}
