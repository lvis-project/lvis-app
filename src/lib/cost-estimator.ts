/**
 * Cost Estimator
 *
 * Pre-send cost preview for the chat input bar (the small badge next to
 * the input). Uses a chars/4 heuristic, ±20% accuracy. *Pre-send only* —
 * post-call display must use provider-reported `usage` from `turn_summary`
 * (see TokenCostBadge / useContextBudget for the post-call surfaces).
 *
 * 2026-05-07 Phase 3: kept as the only client-side estimator. A single
 * tiktoken-equivalent estimate is used for *prediction* before the call and
 * never reconciled against post-call reality. chars/4 is good enough for
 * "will this draft cost a lot?" vibe-check; precise figures come from the
 * provider.
 */

export interface ModelPricingLite {
  inputPer1M: number;
  outputPer1M: number;
}

export interface EstimateInput {
  /** Already-serialized prior history messages. */
  historySerialized: string[];
  /** The draft the user is about to send. */
  draft: string;
  /** Conservative max output tokens the model may produce this turn. */
  maxOutputTokens: number;
  pricing: ModelPricingLite;
}

export interface EstimateBreakdown {
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  total: number;
  pricingKnown?: boolean;
}

/**
 * Mirror of `Math.ceil(serialized.length / 4) + 1` from the engine. Never
 * under-estimates — matches conservative path used by the provider layer.
 */
export function estimateTokens(serialized: string): number {
  if (!serialized) return 0;
  return Math.ceil(serialized.length / 4) + 1;
}

export function estimateTurnCost(input: EstimateInput): EstimateBreakdown {
  const historyTokens = input.historySerialized.reduce(
    (sum, s) => sum + estimateTokens(s),
    0,
  );
  const draftTokens = input.draft ? estimateTokens(JSON.stringify({ role: "user", content: input.draft })) : 0;
  const inputTokens = historyTokens + draftTokens;
  const outputTokens = Math.max(0, input.maxOutputTokens);
  const inputCost = (inputTokens / 1_000_000) * input.pricing.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * input.pricing.outputPer1M;
  return {
    inputTokens,
    outputTokens,
    inputCost,
    outputCost,
    total: inputCost + outputCost,
    pricingKnown: true,
  };
}

export type CostTier = "trivial" | "low" | "medium" | "high";

export function costTier(total: number): CostTier {
  if (total < 0.01) return "trivial";
  if (total < 0.1) return "low";
  if (total < 1) return "medium";
  return "high";
}

export function formatCostBadge(total: number, pricingKnown = true): string {
  if (!pricingKnown) return "비용 미정";
  if (total < 0.01) return `~$${total.toFixed(4)}`;
  if (total < 1) return `~$${total.toFixed(2)}`;
  return `~$${total.toFixed(2)}`;
}
