import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import {
  getLlmVendorSettings,
  narrowLlmVendor,
} from "../../../shared/llm-vendor-defaults.js";
import { DEPTH_BUDGET } from "./ThinkingButton.js";

type Depth = "low" | "medium" | "high";

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

export interface ReasoningLevelOptions {
  /** Host-owned thinking on/off (persisted per-vendor). */
  enabled: boolean;
  onToggle: (next: boolean) => void | Promise<void>;
}

export type ReasoningLevel = 0 | 1 | 2 | 3;

/**
 * The reasoning level as ONE value the composer's controls all read.
 *
 * Level 0 is thinking off; 1–3 are the depths, persisted per vendor as a
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

  const level: ReasoningLevel = enabled ? DEPTH_LEVEL[depth] : 0;

  const levelLabels = [
    t("bottomActionRow.reasoningNone"),
    t("bottomActionRow.thinkingDepthLow"),
    t("bottomActionRow.thinkingDepthMedium"),
    t("bottomActionRow.thinkingDepthHigh"),
  ];

  const apply = useCallback(
    (next: number) => {
      const lvl = Math.max(0, Math.min(3, Math.round(next))) as ReasoningLevel;
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

  return { level, levelLabels, apply };
}

/** The range and its four labels — the same control wherever the level is set. */
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
        max={3}
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
