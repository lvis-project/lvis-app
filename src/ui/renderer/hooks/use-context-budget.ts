import { useMemo } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import { lookupPricing, effectiveContextWindow } from "../../../shared/pricing-data.js";
import { getUsableContext } from "../../../shared/context-budget.js";
import { estimateTokens } from "../../../engine/auto-compact.js";

/**
 * Context budget hook — engine-projected next request input SOT.
 *
 * `usedTokens` = the most recent usage carrier:
 *   - `turn_summary.tokensIn`, the engine-projected next request input emitted
 *     by the main loop and persisted on the final assistant;
 *   - `context_usage.tokensIn`, emitted only after compact so the ring shrinks
 *     immediately to the compacted context estimate.
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
 * Pre-first-turn: returns 0 (no projection yet). Streaming: still uses the
 * *previous* usage carrier until the new live turn_summary lands at turn end.
 *
 * draftText: optional composer draft — when present, its token estimate
 * (chars/4 + Korean 1.3x weighting via estimateTokens) is added on top of
 * the latest context-fill carrier so the ring and color thresholds
 * update as the user types, before the turn starts.
 *
 * Context window source: `src/shared/pricing-data.ts` →
 * `effectiveContextWindow()` (picks 1M-beta tier for Sonnet/Opus 4.6) →
 * `getUsableContext()` (LVIS fixed output/safety reservation).
 */
export function useContextBudget(params: {
  entries: ChatEntry[];
  llmVendor: string;
  llmModel: string;
  draftText?: string;
  draftExtraTokens?: number;
}) {
  const { entries, llmVendor, llmModel, draftText, draftExtraTokens = 0 } = params;

  const contextBudget = useMemo(() => {
    // Effective window picks the 1M beta tier when the model defines one
    // (adapter auto-sends `context-1m-2025-08-07`). LVIS reservation
    // then subtracts output + safety reservation so the ring hits 100% at
    // the compact threshold, not at raw context = full.
    // `lookupPricing` always returns a value (FALLBACK_PRICING on miss),
    // so no null branch is needed here.
    return getUsableContext(effectiveContextWindow(lookupPricing(llmVendor, llmModel)));
  }, [llmVendor, llmModel]);

  const baseTokens = useMemo(() => {
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

  // Add draft token estimate so the ring updates as the user types.
  // estimateTokens applies Korean 1.3x weighting (chars/4 heuristic).
  const draftTokens = useMemo(
    () => (draftText ? estimateTokens(draftText) : 0) + Math.max(0, draftExtraTokens),
    [draftText, draftExtraTokens],
  );

  const usedTokens = baseTokens + draftTokens;

  const contextOverflowPct = useMemo(
    () => (contextBudget > 0 ? usedTokens / contextBudget : 0),
    [usedTokens, contextBudget],
  );

  // Issue #900 #1 — per-request TPM (Tokens Per Minute) projection.
  // contextBudget 는 *cumulative* limit 이지만 OpenAI 의 작은-tier 모델
  // 은 *분당 처리량* 한도가 별도로 작음 (예: nano = 200K TPM). 단발
  // request input 이 *cumulative budget 14%* 라도 TPM 초과로 429. UI 는
  // 두 metric 을 *별도* 표시해 사용자 mental model 분리.
  //
  // tpmLimit 가 등록된 모델만 노출 (nano 등). 미등록 모델은 undefined →
  // UI 가 표시 자체 안 함 (현재 ring 만 유지).
  const tpmLimit = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    return typeof pricing.tpmDefault === "number" && pricing.tpmDefault > 0
      ? pricing.tpmDefault
      : undefined;
  }, [llmVendor, llmModel]);

  const tpmPct = useMemo(
    () => (tpmLimit && tpmLimit > 0 ? usedTokens / tpmLimit : undefined),
    [usedTokens, tpmLimit],
  );

  // Issue #912 — effectiveBudget = min(contextBudget, tpmLimit). The ring
  // uses this binding limit so a TPM-bound model turns red before the user
  // hits a provider-side per-minute rejection, while the tooltip still shows
  // the context-window denominator separately.
  const effectiveBudget = useMemo(
    () => (typeof tpmLimit === "number" && tpmLimit < contextBudget ? tpmLimit : contextBudget),
    [contextBudget, tpmLimit],
  );

  return {
    usedTokens,
    contextBudget,
    contextOverflowPct,
    isOverflow: contextOverflowPct >= 1,
    // #900 #1 — undefined for models without registered tpmDefault.
    tpmLimit,
    tpmPct,
    isTpmOverflow: typeof tpmPct === "number" && tpmPct >= 1,
    // #912 — ring/binding request limit (TPM-bound 모델에선 tpmLimit, else contextBudget).
    effectiveBudget,
  };
}
