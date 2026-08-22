/**
 * LLM Pricing + Context Window Registry
 *
 * Thin Node-side layer over `src/shared/pricing-data.ts`. The shared module
 * holds the vendor/model/$-rate table (browser-safe, no Node-only imports) so
 * the renderer can import the same prices. This module layers per-model price
 * corrections on top.
 *
 * The corrections come from Settings (`llm.pricingOverrides`) or, for a
 * deployment that already sets it, `LVIS_PRICING_OVERRIDE` — both resolved and
 * merged by `shared/pricing-overrides.ts`, so there is one rule rather than an
 * env path and a settings path that could disagree. Callers pass the resolved
 * list in; this module does not reach for a settings service, because the
 * usage aggregation that calls it has to cache against that same list.
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
import {
  applyPricingOverride,
  type PricingOverride,
} from "../../shared/pricing-overrides.js";

export type { ModelPricing, UsageForCost };
export { normalizeAiSdkUsageForCost };

export function getModelPricing(
  vendor: LLMVendor,
  model: string,
  overrides: readonly PricingOverride[] = [],
): ModelPricing {
  // Shared lookup (exact → prefix → FALLBACK_PRICING). lookupPricing already
  // handles the miss path, so no extra wrapping needed here.
  return applyPricingOverride(vendor, model, overrides, lookupPricing(vendor, model));
}

export function getBillableModelPricing(
  vendor: LLMVendor,
  model: string,
  overrides: readonly PricingOverride[] = [],
): ModelPricing | undefined {
  const overridden = overrides.some((e) => e.vendor === vendor && e.model === model);
  // A correction is a statement that this model IS billed at these rates, so
  // it also answers the billable question — including for `azure-foundry`,
  // whose spend the app cannot otherwise attribute.
  if (!overridden && vendor === "azure-foundry") return undefined;
  const pricing = getModelPricing(vendor, model, overrides);
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
