/**
 * Shared LLM pricing data — pure data + pure lookup.
 *
 * Imported by both:
 *   - `engine/llm/pricing.ts` (Node-side, layers env-override + fallback logic on top)
 *   - `renderer.tsx` (browser bundle — must NOT import engine/* because those
 *     reference process.env)
 *
 * Values reflect publicly-announced list prices (2026-04). Free/unknown → 0.
 *
 * IMPORTANT: this module must stay pure — no `process.env`, no Node-only
 * imports. All env-override logic lives on the engine side.
 */

export type PricingVendor =
  | "claude"
  | "openai"
  | "gemini"
  | "copilot"
  | "azure-foundry"
  | "vertex-ai";

/** $ per 1M tokens. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Model's max context window in tokens (for overflow warning). */
  contextWindow: number;
}

/** Default pricing table. */
export const DEFAULT_PRICING: Record<PricingVendor, Record<string, ModelPricing>> = {
  claude: {
    "claude-sonnet-4-6":   { inputPer1M: 3,  outputPer1M: 15,  contextWindow: 1_000_000 },
    "claude-sonnet-4-5":   { inputPer1M: 3,  outputPer1M: 15,  contextWindow: 200_000 },
    "claude-sonnet-4-20250514": { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 },
    "claude-opus-4-6":     { inputPer1M: 15, outputPer1M: 75,  contextWindow: 1_000_000 },
    "claude-opus-4-5":     { inputPer1M: 15, outputPer1M: 75,  contextWindow: 200_000 },
    "claude-opus-4-20250514": { inputPer1M: 15, outputPer1M: 75, contextWindow: 200_000 },
    "claude-haiku-4-5":    { inputPer1M: 1,  outputPer1M: 5,   contextWindow: 200_000 },
    "claude-3-5-sonnet-20241022": { inputPer1M: 3, outputPer1M: 15, contextWindow: 200_000 },
    "claude-3-5-haiku-20241022":  { inputPer1M: 1, outputPer1M: 5,  contextWindow: 200_000 },
  },
  openai: {
    "gpt-5.4":       { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 1_050_000 },
    "gpt-5.4-mini":  { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 1_050_000 },
    "gpt-5.4-nano":  { inputPer1M: 0.5,  outputPer1M: 4,  contextWindow: 1_050_000 },
    "gpt-5.4-pro":   { inputPer1M: 5,    outputPer1M: 40, contextWindow: 1_050_000 },
    "gpt-5":         { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 400_000 },
    "gpt-5-mini":    { inputPer1M: 1.25, outputPer1M: 10, contextWindow: 400_000 },
    "gpt-4.1":       { inputPer1M: 2,    outputPer1M: 8,  contextWindow: 1_000_000 },
    "gpt-4.1-mini":  { inputPer1M: 0.4,  outputPer1M: 1.6, contextWindow: 1_000_000 },
  },
  gemini: {
    "gemini-2.5-flash": { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-pro":   { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_000_000 },
    "gemini-2":         { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_000_000 },
  },
  copilot: {
    "gpt-4.1":  { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
  },
  "azure-foundry": {},
  "vertex-ai": {},
};

export const FALLBACK_PRICING: ModelPricing = {
  inputPer1M: 0,
  outputPer1M: 0,
  contextWindow: 128_000,
};

/**
 * Pure lookup against the default table. Supports exact match, then prefix
 * fallback (e.g. `claude-sonnet-4-6-20260214` → `claude-sonnet-4-6`).
 * Does NOT consult env overrides — callers that care about overrides should
 * use `engine/llm/pricing.ts:getModelPricing()`.
 */
export function lookupPricing(
  vendor: string,
  model: string,
  table: Record<string, Record<string, ModelPricing>> = DEFAULT_PRICING,
): ModelPricing {
  const vendorTable = table[vendor] ?? {};
  const exact = vendorTable[model];
  if (exact) return exact;
  for (const key of Object.keys(vendorTable)) {
    if (model.startsWith(key)) return vendorTable[key];
  }
  return FALLBACK_PRICING;
}
