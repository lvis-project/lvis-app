import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import {
  getLlmVendorSettings,
  DEFAULT_LLM_VENDOR,
  narrowLlmVendor,
} from "../../../shared/llm-vendor-defaults.js";
import { getReasoningDepths, budgetToDepthIndex, reasoningBudgetLabel } from "../constants.js";
import { formatTokensExact } from "../../../lib/cost-format.js";

export interface ReasoningLevelOptions {
  /** Host-owned thinking on/off (persisted per-vendor). */
  enabled: boolean;
  onToggle: (next: boolean) => void | Promise<void>;
}

export type ReasoningLevel = 0 | 1 | 2 | 3 | 4;

/**
 * The reasoning level as ONE value the composer's controls all read.
 *
 * Level 0 is thinking off; the allowed depths are persisted per vendor as a
 * token budget. The depth follows the settings broadcast rather than a
 * one-time seed, because more than one surface shows it — the status-row
 * chip, the model card it opens, and every other tile's composer — and a
 * change made in any of them has to reach the rest.
 */
export function useReasoningLevel({ enabled, onToggle }: ReasoningLevelOptions): {
  level: ReasoningLevel;
  levelLabels: string[];
  currentLabel: string;
  custom: boolean;
  apply: (next: number) => void;
} {
  const { t } = useTranslation();
  const [block, setBlock] = useState(() => getLlmVendorSettings(undefined, DEFAULT_LLM_VENDOR));
  const depths = useMemo(() => getReasoningDepths(block.outputTokenLimit), [block.outputTokenLimit]);

  useEffect(() => {
    let cancelled = false;
    const seed = (llm: { provider: unknown; vendors: Parameters<typeof getLlmVendorSettings>[0] }) => {
      if (!cancelled) setBlock(getLlmVendorSettings(llm.vendors, narrowLlmVendor(llm.provider)));
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

  const persistDepth = useCallback(async (index: number) => {
    try {
      const api = getApi();
      const s = await api.getSettings();
      const provider = narrowLlmVendor(s.llm.provider);
      const currentBlock = getLlmVendorSettings(s.llm.vendors, provider);
      const currentDepths = getReasoningDepths(currentBlock.outputTokenLimit);
      // A concurrent output-limit change can shorten the available ladder.
      const next = currentDepths[Math.min(index, currentDepths.length - 1)];
      if (!next) return;
      await api.updateSettings({
        llm: { vendors: { [provider]: { thinkingBudgetTokens: next.budget } } },
      });
    } catch {
      /* best-effort; UI state already updated */
    }
  }, []);

  const level: ReasoningLevel = enabled
    ? (Math.max(1, budgetToDepthIndex(block.thinkingBudgetTokens, depths) + 1) as ReasoningLevel) : 0;
  const custom = enabled && !depths.some((depth) => depth.budget === block.thinkingBudgetTokens);
  const budgetLabel = `${reasoningBudgetLabel(block.thinkingBudgetTokens, depths)} · ${t("llmTab.reasoningBudgetTokens", {
    count: formatTokensExact(block.thinkingBudgetTokens),
  })}`;
  const currentLabel = enabled ? budgetLabel : t("bottomActionRow.reasoningNone");

  // The same names the settings tab shows, off the same ladder — the composer
  // used to carry its own copies, and in Korean they had already drifted
  // ("중간" here against "보통" there) for what is one setting.
  const levelLabels = [t("bottomActionRow.reasoningNone"), ...(depths.length > 0 ? depths.map((d) => d.label) : [budgetLabel])];

  const apply = useCallback(
    (next: number) => {
      if (!Number.isFinite(next)) return;
      const lvl = Math.max(0, Math.min(Math.max(1, depths.length), Math.round(next))) as ReasoningLevel;
      if (lvl === 0) {
        if (enabled) void onToggle(false);
        return;
      }
      if (!enabled) void onToggle(true);
      const depth = depths[lvl - 1];
      // Below the first preset, enabling preserves the existing custom budget.
      if (!depth) return;
      setBlock((current) => ({ ...current, thinkingBudgetTokens: depth.budget }));
      void persistDepth(lvl - 1);
    },
    [depths, enabled, onToggle, persistDepth],
  );

  return { level, levelLabels, currentLabel, custom, apply };
}

/** The current value and allowed choices, shared by both composer triggers. */
export function ReasoningLevelControl({
  level,
  levelLabels,
  currentLabel,
  custom,
  apply,
  label,
}: {
  level: ReasoningLevel;
  levelLabels: string[];
  currentLabel: string;
  custom: boolean;
  apply: (next: number) => void;
  label: string;
}) {
  return (
    <>
      {custom && <span className="text-micro text-muted-foreground">{currentLabel}</span>}
      <input
        type="range"
        min={0}
        max={levelLabels.length - 1}
        disabled={levelLabels.length === 1}
        step={1}
        value={level}
        onChange={(e) => apply(Number(e.target.value))}
        aria-label={`${label}: ${currentLabel}`}
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
              idx === level && !custom ? "font-medium text-primary" : ""
            }`}
          >
            {text}
          </button>
        ))}
      </div>
    </>
  );
}
