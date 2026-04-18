/**
 * Shared reasoning-effort steps + budget→effort mapping.
 *
 * Single source of truth consumed by:
 *   - renderer.tsx (slider UI — step list drives the discrete thumb positions)
 *   - vercel/adapter.ts (Anthropic mapBudgetToEffort uses budgetToEffort)
 *
 * Note: OpenAI's mapReasoningEffort in vercel/adapter.ts stays vendor-specific
 * because it owns the extra "none" band (budget ≤ 500, GPT-5.2+ only) which
 * Anthropic does not expose. It intentionally does NOT call budgetToEffort.
 */

// Slider anchor points. These map to the 4 discrete thumb positions in the UI.
// Budget values are chosen to land cleanly in both OpenAI mapReasoningEffort
// (≤3000=low, ≤8000=medium, >8000=high) and Anthropic budgetToEffort
// (≤3000=low, ≤6000=medium, ≤16000=high, >16000=max) in vercel/adapter.ts.
export const REASONING_EFFORT_STEPS = [
  { budget: 2000, label: "low" },
  { budget: 6000, label: "medium" },
  { budget: 12000, label: "high" },
  { budget: 24000, label: "max" },
] as const;

export type ReasoningEffort = "low" | "medium" | "high" | "max";

/**
 * Map a token budget to a discrete reasoning effort label.
 * Matches Anthropic adaptive-thinking thresholds in vercel/adapter.ts.
 *   budget ≤  3 000 → "low"
 *   budget ≤  6 000 → "medium"
 *   budget ≤ 16 000 → "high"
 *   budget >  16 000 → "max"
 */
export function budgetToEffort(budget: number): ReasoningEffort {
  if (budget <= 3000) return "low";
  if (budget <= 6000) return "medium";
  if (budget <= 16_000) return "high";
  return "max";
}
