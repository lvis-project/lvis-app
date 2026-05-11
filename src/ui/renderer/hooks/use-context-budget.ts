import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { lookupPricing, effectiveContextWindow } from "../../../shared/pricing-data.js";
import { getUsableContext } from "../../../shared/context-budget.js";

/**
 * Context budget hook — provider-truth based (Phase 3, 2026-05-07).
 *
 * `usedTokens` = the most recent usage carrier:
 *   - live turn: `turn_summary.tokensIn` from the provider's last raw input;
 *   - loaded session: `context_usage.tokensIn`, the main-process estimate
 *     rebuilt from persisted messages.
 *
 * This is the right denominator for the context-fill ring because cache reads
 * still occupy context-window slots even though they're billed at 1/10 the
 * rate. The billing-weight number lives on `freshInputTokens`
 * (TokenCostBadge), which is a different question.
 *
 * Replaces the old `entries.map(chars/4).sum()` heuristic which:
 *   - missed system prompt (12-source assembly), tool schemas, memory
 *     injection — all huge contributors that a renderer-side serializer
 *     can't see;
 *   - over-counted under-Korean content because chars/4 ≠ tokens/4 (1.7-2);
 *   - did not shrink after compact since entries persisted in UI.
 *
 * Pre-first-turn: returns 0 (no usage yet). Streaming: still uses the
 * *previous* usage carrier until the new live turn_summary lands at turn end.
 *
 * Context window source: `src/shared/pricing-data.ts` →
 * `effectiveContextWindow()` (picks 1M-beta tier for Sonnet/Opus 4.6) →
 * `getUsableContext()` (Cline-style fixed buffer for output reservation).
 */
export function useContextBudget(params: {
  entries: ChatEntry[];
  llmVendor: string;
  llmModel: string;
}) {
  const { entries, llmVendor, llmModel } = params;

  const contextBudget = useMemo(() => {
    // Effective window picks the 1M beta tier when the model defines one
    // (adapter auto-sends `context-1m-2025-08-07`). Cline-style buffer
    // then subtracts output + safety reservation so the ring hits 100% at
    // the actual rotation point, not at raw context = full.
    // `lookupPricing` always returns a value (FALLBACK_PRICING on miss),
    // so no null branch is needed here.
    return getUsableContext(effectiveContextWindow(lookupPricing(llmVendor, llmModel)));
  }, [llmVendor, llmModel]);

  const usedTokens = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.kind === "turn_summary" || e?.kind === "context_usage") {
        return Math.max(0, e.tokensIn);
      }
    }
    return 0;
    // Memo key avoids the O(n) scan on every streaming delta — the array
    // identity changes but the *last* entry is the only one that matters
    // for the latest turn_summary. Mirrors the pattern in `use-cost-estimate`.
  }, [entries.length, entries[entries.length - 1]]);

  const contextOverflowPct = useMemo(
    () => (contextBudget > 0 ? usedTokens / contextBudget : 0),
    [usedTokens, contextBudget],
  );

  return {
    usedTokens,
    contextBudget,
    contextOverflowPct,
    isOverflow: contextOverflowPct >= 1,
  };
}
