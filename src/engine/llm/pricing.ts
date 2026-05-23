/**
 * LLM Pricing + Context Window Registry
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
  computeCost as sharedComputeCost,
  hasKnownTokenPricing,
  lookupPricing,
  normalizeAiSdkUsageForCost,
  type ModelPricing,
  type UsageForCost,
} from "../../shared/pricing-data.js";

export type { ModelPricing, UsageForCost };
export { normalizeAiSdkUsageForCost };

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
  const overridden = getOverride()?.[vendor]?.[model];
  if (overridden) return overridden;
  // Shared lookup (exact → prefix → FALLBACK_PRICING). lookupPricing already
  // handles the miss path, so no extra wrapping needed here.
  return lookupPricing(vendor, model);
}

export function getBillableModelPricing(vendor: LLMVendor, model: string): ModelPricing | undefined {
  const overridden = getOverride()?.[vendor]?.[model];
  if (overridden) return hasKnownTokenPricing(overridden) ? overridden : undefined;
  if (vendor === "azure-foundry") return undefined;
  const pricing = getModelPricing(vendor, model);
  return hasKnownTokenPricing(pricing) ? pricing : undefined;
}

/**
 * Compute cost (USD) for one turn — thin re-export over `shared/pricing-data.ts`.
 *
 * The formula + vendor-asymmetry logic lives in the shared module so the
 * renderer billing badge (`TokenCostBadge`) consumes the same source of
 * truth without pulling Node-only imports. Engine callers keep using this
 * signature for back-compat.
 */
export function computeCost(
  usage: UsageForCost,
  pricing: ModelPricing,
  vendor: LLMVendor,
): number {
  return sharedComputeCost(usage, pricing, vendor);
}

export const PRICING_TABLE = DEFAULT_PRICING;
