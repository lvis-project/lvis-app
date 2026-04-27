/**
 * Test helper — produces an `LLMSettings` shape compatible with the
 * per-vendor schema. Used by engine + hook + ipc tests that stub
 * `settingsService.get("llm")` and need a complete vendors map.
 */
import {
  freshVendorBlocks,
  type LLMVendor,
} from "../llm-vendor-defaults.js";

export function fakeLlmSettings(overrides: {
  provider?: LLMVendor;
  /** Shorthand: override the active vendor's model without spelling out the block. */
  model?: string;
  /** Shorthand: override the active vendor's maxOutputTokens. */
  maxOutputTokens?: number;
} = {}) {
  const provider: LLMVendor = overrides.provider ?? "openai";
  const vendors = freshVendorBlocks();
  if (overrides.model !== undefined) vendors[provider].model = overrides.model;
  if (overrides.maxOutputTokens !== undefined) {
    vendors[provider].maxOutputTokens = overrides.maxOutputTokens;
  }
  return {
    provider,
    vendors,
    streamSmoothing: "none" as const,
    fallbackChain: [],
  };
}
