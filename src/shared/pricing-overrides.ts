/**
 * Per-model price corrections — one parse, one merge, one signature.
 *
 * An organisation on negotiated rates sees the wrong number everywhere the app
 * reports spend, because the built-in table holds public list prices. The
 * correction has existed for a while as `LVIS_PRICING_OVERRIDE`, a JSON blob
 * in the environment — which a packaged app's user cannot set, so it was a
 * lever nobody could reach.
 *
 * Two shapes reach this module and both must mean the same thing:
 *   - the settings list, `[{ vendor, model, inputPer1M, outputPer1M, … }]`,
 *     which is what a table editor can produce and validate row by row;
 *   - the env blob, `{ vendor: { model: { inputPer1M, … } } }`, which is the
 *     shape already deployed and must keep working unchanged.
 *
 * Everything downstream consumes the list. The env blob is translated on the
 * way in rather than handled as a second case, so there is exactly one merge
 * rule, one validity rule, and one cache signature.
 */
import { lookupPricing, type ModelPricing } from "./pricing-data.js";

/**
 * One corrected model rate.
 *
 * Only the four billed rates are correctable. `contextWindow` and its beta
 * sibling are capability facts about the model, not prices — a deployment that
 * "overrode" them would be misreporting what the model can do, and the auto
 * compaction that reads them would act on the lie.
 */
export interface PricingOverride {
  vendor: string;
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  cacheReadPer1M?: number;
  cacheWritePer1M?: number;
}

/** The optional rates, named once so the normalizer and the merge agree on the set. */
const OPTIONAL_PRICING_OVERRIDE_RATES = [
  "cacheReadPer1M",
  "cacheWritePer1M",
] as const;

/**
 * A rate is a non-negative finite number. Zero is meaningful — a deployment
 * with a free internal endpoint states it by writing 0, which is a different
 * claim from "we do not know", and only the first one is expressible here.
 *
 * Exported so the editor can disable Save on a row this would drop, rather
 * than letting the user save a row that silently vanishes.
 */
export function isPricingOverrideRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeOne(input: unknown): PricingOverride | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const vendor = typeof obj.vendor === "string" ? obj.vendor.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (vendor === "" || model === "") return undefined;
  if (!isPricingOverrideRate(obj.inputPer1M) || !isPricingOverrideRate(obj.outputPer1M)) return undefined;
  const entry: PricingOverride = {
    vendor,
    model,
    inputPer1M: obj.inputPer1M,
    outputPer1M: obj.outputPer1M,
  };
  for (const key of OPTIONAL_PRICING_OVERRIDE_RATES) {
    const value = obj[key];
    if (isPricingOverrideRate(value)) entry[key] = value;
  }
  return entry;
}

/**
 * Validate a stored or patched list.
 *
 * A malformed row is dropped rather than rejecting the whole list: the
 * alternative is that one bad row from a hand-edited settings file silently
 * reverts every correct row to list price. Later rows win over earlier ones
 * for the same vendor+model, so a list can be appended to without the writer
 * having to find and edit the existing row.
 */
export function normalizePricingOverrides(value: unknown): PricingOverride[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, PricingOverride>();
  for (const raw of value) {
    const entry = normalizeOne(raw);
    if (entry) byKey.set(`${entry.vendor}\u0000${entry.model}`, entry);
  }
  return [...byKey.values()];
}

/**
 * The deployed env shape, flattened to the list shape.
 *
 * Unparseable JSON yields an empty list, exactly as the previous inline
 * `try/catch` did: a typo in a deployment variable must not make the app
 * report zero cost, it must make the app report list price.
 */
export function parsePricingOverrideEnv(raw: string | undefined): PricingOverride[] {
  if (raw === undefined || raw.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const flattened: unknown[] = [];
  for (const [vendor, models] of Object.entries(parsed as Record<string, unknown>)) {
    if (!models || typeof models !== "object" || Array.isArray(models)) continue;
    for (const [model, rates] of Object.entries(models as Record<string, unknown>)) {
      if (!rates || typeof rates !== "object" || Array.isArray(rates)) continue;
      flattened.push({ ...(rates as Record<string, unknown>), vendor, model });
    }
  }
  return normalizePricingOverrides(flattened);
}

/**
 * The list actually in force.
 *
 * Whole-list precedence, not per-row: the same rule every other env-backed
 * setting follows, and the only one a user can reason about. A merged list
 * would mean the Settings table showed rows that were partly in effect, with
 * nothing on screen able to say which ones.
 */
export function resolvePricingOverrides(
  setting: readonly PricingOverride[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): readonly PricingOverride[] {
  const fromEnv = parsePricingOverrideEnv(env.LVIS_PRICING_OVERRIDE);
  if (fromEnv.length > 0) return fromEnv;
  return setting ?? [];
}

/**
 * The base rates with any correction for this model laid over them.
 *
 * A merge, not a replacement. The override carries prices only, so replacing
 * would drop `contextWindow` — and a `ModelPricing` with no context window is
 * a value the type says cannot exist, handed to callers that budget against
 * it. The previous env path replaced, which is why an env blob had to restate
 * the context window to avoid corrupting it.
 */
export function applyPricingOverride(
  vendor: string,
  model: string,
  overrides: readonly PricingOverride[],
  base: ModelPricing = lookupPricing(vendor, model),
): ModelPricing {
  const match = overrides.find((entry) => entry.vendor === vendor && entry.model === model);
  if (!match) return base;
  const merged: ModelPricing = {
    ...base,
    inputPer1M: match.inputPer1M,
    outputPer1M: match.outputPer1M,
  };
  for (const key of OPTIONAL_PRICING_OVERRIDE_RATES) {
    const value = match[key];
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

/**
 * Cache identity for a resolved list.
 *
 * The usage aggregation caches its result against the inputs that could change
 * the answer, and a price correction changes every cost in it. Order-stable so
 * two lists that differ only in row order do not invalidate the cache.
 */
export function pricingOverridesSignature(overrides: readonly PricingOverride[]): string {
  return JSON.stringify(
    [...overrides]
      .map((entry) => [
        entry.vendor,
        entry.model,
        entry.inputPer1M,
        entry.outputPer1M,
        entry.cacheReadPer1M ?? null,
        entry.cacheWritePer1M ?? null,
      ])
      .sort((left, right) => String(left).localeCompare(String(right))),
  );
}
