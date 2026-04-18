import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { lookupPricing } from "../../../shared/pricing-data.js";

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Phase 5 — context budget hook.
 *
 * Computes per-model context window + current usage estimate via a chars/4
 * heuristic that approximates the engine's token count (±20%). It is NOT the
 * authoritative estimator — the hook omits richer fields (thinkingBlocks,
 * toolCalls, toolUseId, toolName, etc.) that `serializeMessageForEstimation`
 * in `src/engine/llm/types.ts` serializes for the auto-compact trigger. Use
 * this only for UI overflow badges; real budget decisions must go through the
 * engine-side serializer.
 *
 * Context-window source: `src/shared/pricing-data.ts` (single source of truth,
 * shared with cost-estimator). Unknown vendor/model falls back to 128k.
 */
export function useContextBudget(params: {
  entries: ChatEntry[];
  llmVendor: string;
  llmModel: string;
}) {
  const { entries, llmVendor, llmModel } = params;

  const contextBudget = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    return pricing?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  }, [llmVendor, llmModel]);

  // Keyed on length + last-entry identity (matches use-cost-estimate pattern):
  // during streaming, `entries` reference changes per delta but only the last
  // entry mutates. Re-serialize only when a new entry is appended or the
  // tail entry's object identity changes.
  const usedTokens = useMemo(() => {
    let total = 0;
    for (const e of entries) {
      let serialized = "";
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        serialized = JSON.stringify({ kind: e.kind, text: (e as { text?: string }).text ?? "" });
      } else if (e.kind === "tool_group") {
        serialized = JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: { input?: unknown; result?: unknown }) => ({
            input: t.input ?? {},
            result: t.result ?? "",
          })),
        });
      }
      if (serialized) total += Math.ceil(serialized.length / 4) + 1;
    }
    return total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, entries[entries.length - 1]]);

  const contextOverflowPct = useMemo(() => {
    // Rough character-count estimate (~4 chars/token) used for overflow badge.
    // Separate from `usedTokens` which uses the richer serialization heuristic.
    const estimatedTokens = entries.reduce((sum, e) => {
      if (e.kind === "user" || e.kind === "assistant") return sum + Math.ceil(e.text.length / 4);
      return sum;
    }, 0);
    return estimatedTokens / contextBudget;
  }, [entries, contextBudget]);

  const contextPercent = Math.min(100, Math.round((usedTokens / contextBudget) * 100));
  const contextColor =
    contextPercent < 50 ? "text-emerald-500" :
    contextPercent < 80 ? "text-amber-500" : "text-red-500";

  return {
    usedTokens,
    contextBudget,
    contextPercent,
    contextColor,
    contextOverflowPct,
    isOverflow: contextOverflowPct >= 1,
  };
}
