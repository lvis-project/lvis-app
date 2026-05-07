import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { lookupPricing, effectiveContextWindow } from "../../../shared/pricing-data.js";
import { getUsableContext } from "../../../shared/context-budget.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Context budget hook — provider-truth based (Phase 3, 2026-05-07).
 *
 * `usedTokens` = the most recent `turn_summary` entry's `tokensIn`. Engine
 * already applies the Kilo Code pattern (Vercel AI SDK v6 normalized
 * inputTokens minus cacheRead/cacheWrite → fresh-only) before emitting, so
 * this number reflects the *actual* fresh prompt size the provider just
 * billed. Auto-compact reduces it on the next turn; the ring shrinks
 * accordingly.
 *
 * Replaces the old `entries.map(chars/4).sum()` heuristic which:
 *   - missed system prompt (12-source assembly), tool schemas, memory
 *     injection — all huge contributors that a renderer-side serializer
 *     can't see;
 *   - over-counted under-Korean content because chars/4 ≠ tokens/4 (1.7-2);
 *   - did not shrink after compact since entries persisted in UI.
 *
 * Pre-first-turn: returns 0 (no usage yet). Streaming: still uses the
 * *previous* turn_summary until the new one lands at turn end.
 *
 * Context window source: `src/shared/pricing-data.ts`. Unknown model → 128k.
 */
export function useContextBudget(params: {
  entries: ChatEntry[];
  llmVendor: string;
  llmModel: string;
}) {
  const { entries, llmVendor, llmModel } = params;

  const contextBudget = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    // Effective window picks the 1M beta tier when the model defines one
    // (adapter auto-sends `context-1m-2025-08-07`). Cline-style buffer
    // then subtracts output + safety reservation so the ring hits 100% at
    // the actual rotation point, not at raw context = full.
    const raw = pricing ? effectiveContextWindow(pricing) : DEFAULT_CONTEXT_WINDOW;
    return getUsableContext(raw);
  }, [llmVendor, llmModel]);

  const usedTokens = useMemo(() => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.kind === "turn_summary") {
        return Math.max(0, e.tokensIn);
      }
    }
    return 0;
  }, [entries]);

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
