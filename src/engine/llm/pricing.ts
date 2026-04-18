/**
 * LLM Pricing + Context Window Registry — Sprint 4.B (Observability)
 *
 * Thin Node-side layer over `src/shared/pricing-data.ts`. The shared module
 * holds the vendor/model/$-rate table (browser-safe, no Node-only imports) so
 * the renderer can import the same prices. This module layers env-override
 * logic via `LVIS_PRICING_OVERRIDE` JSON on top.
 *
 * Values reflect publicly-announced list prices (2026-04). Free/unknown → 0.
 */
import type { LLMVendor } from "./types.js";
import {
  DEFAULT_PRICING,
  FALLBACK_PRICING,
  lookupPricing,
  type ModelPricing,
} from "../../shared/pricing-data.js";

export type { ModelPricing };

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
  // Shared lookup (exact → prefix → FALLBACK_PRICING).
  const base = lookupPricing(vendor, model);
  if (base !== FALLBACK_PRICING) return base;
  return FALLBACK_PRICING;
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
