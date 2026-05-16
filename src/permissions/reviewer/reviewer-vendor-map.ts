/**
 * Reviewer vendor map — single source of truth for UI-facing provider name
 * → canonical LLM vendor name translation.
 *
 * The reviewer settings UI uses provider names ("openai", "anthropic",
 * "google", "foundry", "gcp-playground") that differ from the canonical
 * secret-store vendor names used by the chat LLM providers ("openai",
 * "claude", "gemini", "azure-foundry").
 *
 * This module owns the translation so both boot.ts and provider-adapters.ts
 * import from one place instead of maintaining separate maps.
 *
 * "foundry" and "gcp-playground" are handled by dedicated branches in
 * reviewerProviderKeyPresent / resolveReviewerAdapter — they are intentionally
 * absent from REVIEWER_VENDOR_MAP.
 */
import type { LLMVendor } from "../../shared/llm-vendor-defaults.js";

/**
 * Maps UI-facing reviewer provider names to canonical LLM vendor names.
 *
 * Used by `reviewerProviderKeyPresent` and `reviewerStreamProviderFor` (boot)
 * to look up the correct `llm.apiKey.<vendor>` secret.
 *
 * "foundry" and "gcp-playground" intercept earlier in their respective call
 * sites and do not appear here — their secret keys are defined as constants
 * (FOUNDRY_API_KEY_SECRET, GCP_PLAYGROUND_API_KEY_SECRET) in provider-adapters.ts.
 */
export const REVIEWER_VENDOR_MAP: Readonly<Record<string, LLMVendor>> = {
  openai: "openai",
  anthropic: "claude",
  google: "gemini",
} as const;

/**
 * Resolve the canonical {@link LLMVendor} for a given reviewer provider name.
 *
 * Returns `null` for "foundry", "gcp-playground", and any unknown provider
 * (callers handle those branches separately).
 */
export function reviewerVendorFor(provider: string): LLMVendor | null {
  return (REVIEWER_VENDOR_MAP as Record<string, LLMVendor | undefined>)[provider] ?? null;
}
