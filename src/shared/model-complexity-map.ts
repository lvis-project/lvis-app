/**
 * Single source of truth for the agent-profile **complexity level**
 * ("low" / "mid" / "high") → vendor-specific model resolver used by
 * `SubAgentRunner` when an agent profile's `model:` frontmatter is a
 * complexity tier instead of an explicit model ID.
 *
 * Why a separate SOT (vs. baking it into llm-vendor-defaults.ts):
 *   - `llm-vendor-defaults.ts` is the SOT for the user-facing settings
 *     dialog: which vendors exist, which models the dropdown shows, what
 *     defaults each vendor block ships with. That file answers "what can
 *     the user pick?" It must stay decoupled from agent-profile semantics
 *     so a marketplace plugin adding new agent profiles never needs to
 *     touch the vendor list.
 *   - This file answers a different question: "given the active vendor
 *     and a tier the profile writer specified, which model ID should the
 *     sub-agent run against?" The mapping is opinionated — a complexity
 *     tier is *not* a model ID, and the resolver knows about each
 *     vendor's model catalog only enough to pick three representatives.
 *
 * Design-intent fallback (per LVIS CLAUDE.md "No Fallback Code" rule):
 *   - When a vendor block is missing the tier (e.g. a new vendor enrolled
 *     before the map is updated), `resolveModelForComplexity` returns
 *     `null` and the caller MUST fall back to the parent loop's active
 *     model. That fallback is a *design-intent safety path* — not a
 *     legacy alias — and the caller is required to log "parent-model
 *     fallback used" so the audit trail captures the gap.
 *   - All known tiers must resolve to a model that also appears in
 *     `LLM_VENDOR_MODEL_OPTIONS[vendor]` for that vendor — verified by
 *     the unit test under `__tests__/`.
 *
 * Cross-importer boundary:
 *   - Imported by `SubAgentRunner` (engine) and `agent-profile-store`
 *     (main). Pure / browser-safe — no Electron / Node imports.
 *   - When a new vendor lands in `LLM_VENDORS`, this map MUST be
 *     extended in the same PR. The compile-time `Record<LLMVendor, ...>`
 *     constraint guarantees the typecheck fails until each new vendor
 *     declares its tiers.
 */
import {
  LLM_VENDOR_MODEL_OPTIONS,
  type LLMVendor,
} from "./llm-vendor-defaults.js";

/**
 * Complexity tiers an agent profile may declare in its `model:`
 * frontmatter. Anything outside this union is treated as an explicit
 * vendor-specific model ID and passed through unchanged.
 */
export const MODEL_COMPLEXITY_LEVELS = ["low", "mid", "high"] as const;
export type ModelComplexityLevel = (typeof MODEL_COMPLEXITY_LEVELS)[number];

/**
 * Runtime guard for `unknown` inputs (e.g. profile frontmatter parsed
 * from disk). Strings outside the union return false; callers should
 * treat such values as a vendor-specific model ID, not a tier.
 */
export function isModelComplexityLevel(
  value: unknown,
): value is ModelComplexityLevel {
  return (
    typeof value === "string" &&
    (MODEL_COMPLEXITY_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Vendor × tier → model ID. Each cell MUST also appear in
 * `LLM_VENDOR_MODEL_OPTIONS[vendor]` (enforced by unit test).
 *
 * Picking rationale per vendor:
 *   - low: fastest / cheapest tier suitable for narrow lookups and
 *     short-form generation (e.g. `explorer` agent's file/email scan).
 *   - mid: balanced workhorse for staff office artifacts (memo, table,
 *     meeting minutes). Used by `executor` and `researcher`.
 *   - high: deep-reasoning model for analysis / multi-step planning
 *     (e.g. `planner`'s 7-dimension clarity scoring loop).
 */
export const MODEL_COMPLEXITY_MAP: Readonly<
  Record<LLMVendor, Readonly<Record<ModelComplexityLevel, string>>>
> = Object.freeze({
  claude: Object.freeze({
    low: "claude-haiku-4-5",
    mid: "claude-sonnet-4-6",
    high: "claude-opus-4-6",
  }),
  openai: Object.freeze({
    low: "gpt-5.4-nano",
    mid: "gpt-5.4-mini",
    high: "gpt-5.4",
  }),
  gemini: Object.freeze({
    low: "gemini-2.5-flash-lite",
    mid: "gemini-2.5-flash",
    high: "gemini-2.5-pro",
  }),
  copilot: Object.freeze({
    low: "gpt-5.4-nano",
    mid: "gpt-5.4-mini",
    high: "gpt-5.4",
  }),
  "azure-foundry": Object.freeze({
    low: "gpt-5.4-nano",
    mid: "gpt-5.4-mini",
    high: "gpt-5.4",
  }),
  "vertex-ai": Object.freeze({
    low: "gemini-2.5-flash-lite",
    mid: "gemini-2.5-flash",
    high: "gemini-2.5-pro",
  }),
});

/**
 * Resolve `(vendor, level)` to a concrete model ID. Returns `null` when
 * either argument is missing or the tier is undefined for that vendor —
 * the caller must apply the design-intent parent-model fallback.
 */
export function resolveModelForComplexity(
  vendor: LLMVendor | null | undefined,
  level: ModelComplexityLevel | null | undefined,
): string | null {
  if (!vendor || !level) return null;
  const vendorMap = MODEL_COMPLEXITY_MAP[vendor];
  if (!vendorMap) return null;
  return vendorMap[level] ?? null;
}

/**
 * Verify every tier in the map points at a model also listed in
 * `LLM_VENDOR_MODEL_OPTIONS[vendor]`. Called from the unit test; kept
 * in the source file so a future contributor adding a new vendor or
 * tier can quickly assert their addition stays self-consistent.
 *
 * Returns the list of `(vendor, tier, model)` triples that DO NOT
 * appear in the vendor's option list. An empty array means the map
 * is self-consistent.
 */
export function findOrphanedComplexityModels(): Array<{
  vendor: LLMVendor;
  level: ModelComplexityLevel;
  model: string;
}> {
  const orphans: Array<{
    vendor: LLMVendor;
    level: ModelComplexityLevel;
    model: string;
  }> = [];
  for (const [vendor, tiers] of Object.entries(MODEL_COMPLEXITY_MAP) as Array<
    [LLMVendor, Record<ModelComplexityLevel, string>]
  >) {
    const options = LLM_VENDOR_MODEL_OPTIONS[vendor];
    for (const level of MODEL_COMPLEXITY_LEVELS) {
      const model = tiers[level];
      if (!options.includes(model)) {
        orphans.push({ vendor, level, model });
      }
    }
  }
  return orphans;
}
