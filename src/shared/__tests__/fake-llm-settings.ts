/**
 * Test helper — produces an `LLMSettings` shape compatible with the
 * per-vendor schema. Used by engine + hook + ipc tests that stub
 * `settingsService.get("llm")` and need a complete vendors map.
 *
 * CTRL simplification: maxOutputTokens override removed — field no longer
 * exists on LLMVendorSettings.
 */
import {
  freshAllVendorBlocks,
  type LLMVendor,
} from "../llm-vendor-defaults.js";

export function fakeLlmSettings(overrides: {
  provider?: LLMVendor;
  /** Shorthand: override the active route's model without spelling out the block. */
  model?: string;
  /**
   * Selects a marketplace provider preset. The model then lands in that
   * preset's own slot, which is where the route reads it — the block's single
   * `model` belongs to the generic custom-provider row.
   */
  marketplaceProviderPresetId?: string;
} = {}) {
  const provider: LLMVendor = overrides.provider ?? "openai";
  const presetId = overrides.marketplaceProviderPresetId;
  const vendors = freshAllVendorBlocks();
  if (overrides.model !== undefined) {
    if (presetId) vendors[provider].presetModels = { [presetId]: overrides.model };
    else vendors[provider].model = overrides.model;
  }
  return {
    provider,
    vendors,
    ...(presetId ? { marketplaceProviderPresetId: presetId } : {}),
    streamSmoothing: "none" as const,
    fallbackChain: [],
    modelListCache: {},
  };
}
