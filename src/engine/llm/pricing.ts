/**
 * LLM Pricing + Context Window Registry — Sprint 4.B (Observability)
 *
 * Hardcoded per-1M-token USD pricing for each vendor/model. Env override via
 * `LVIS_PRICING_OVERRIDE` JSON (same shape as the default table).
 *
 * Values reflect publicly-announced list prices (2026-04). Free/unknown → 0.
 */
import type { LLMVendor } from "./types.js";

/** $ per 1M tokens. */
export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
  /** Model's max context window in tokens (for overflow warning). */
  contextWindow: number;
}

/** Default pricing table. Override via env `LVIS_PRICING_OVERRIDE`. */
const DEFAULT_PRICING: Record<LLMVendor, Record<string, ModelPricing>> = {
  claude: {
    // Anthropic public pricing
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
    // Free tier default — user must opt into paid billing
    "gemini-2.5-flash": { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
    "gemini-2.5-pro":   { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_000_000 },
    "gemini-2":         { inputPer1M: 0, outputPer1M: 0, contextWindow: 2_000_000 },
  },
  copilot: {
    "gpt-4.1":  { inputPer1M: 0, outputPer1M: 0, contextWindow: 1_000_000 },
  },
  // Azure AI Foundry / Vertex AI expose vendor-specific models under their own
  // billing. Default tables are empty; overrides via LVIS_PRICING_OVERRIDE.
  "azure-foundry": {},
  "vertex-ai": {},
};

const FALLBACK: ModelPricing = { inputPer1M: 0, outputPer1M: 0, contextWindow: 128_000 };

let cachedOverride: Record<LLMVendor, Record<string, ModelPricing>> | null = null;
let cachedOverrideEnv: string | undefined = undefined;

function getOverride(): Record<LLMVendor, Record<string, ModelPricing>> | null {
  const raw = process.env.LVIS_PRICING_OVERRIDE;
  if (raw === cachedOverrideEnv) return cachedOverride;
  cachedOverrideEnv = raw;
  if (!raw) { cachedOverride = null; return null; }
  try {
    cachedOverride = JSON.parse(raw) as Record<LLMVendor, Record<string, ModelPricing>>;
  } catch {
    cachedOverride = null;
  }
  return cachedOverride;
}

export function getModelPricing(vendor: LLMVendor, model: string): ModelPricing {
  const override = getOverride();
  const overridden = override?.[vendor]?.[model];
  if (overridden) return overridden;
  const base = DEFAULT_PRICING[vendor]?.[model];
  if (base) return base;
  // Prefix fallback — e.g. "claude-sonnet-4-6-20260214" → "claude-sonnet-4-6"
  const table = DEFAULT_PRICING[vendor] ?? {};
  for (const key of Object.keys(table)) {
    if (model.startsWith(key)) return table[key];
  }
  return FALLBACK;
}

/**
 * Compute cost (USD) given per-1M pricing and token counts.
 */
export function computeCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

export const PRICING_TABLE = DEFAULT_PRICING;
