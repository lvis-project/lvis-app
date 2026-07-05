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
  /** Shorthand: override the active vendor's model without spelling out the block. */
  model?: string;
  /** #893 — top-level authMode toggle. Defaults to "manual". */
  authMode?: "manual" | "login";
} = {}) {
  const provider: LLMVendor = overrides.provider ?? "openai";
  const vendors = freshAllVendorBlocks();
  if (overrides.model !== undefined) vendors[provider].model = overrides.model;
  return {
    authMode: overrides.authMode ?? "manual" as const,
    provider,
    vendors,
    streamSmoothing: "none" as const,
    fallbackChain: [],
  };
}
