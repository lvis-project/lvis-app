/**
 * Vendor + model vision capability lookup.
 *
 * The composer allows attaching images regardless of the active model — users
 * may switch models before sending. At send time we check supportsVision()
 * and surface a confirmation dialog when attaching images to a model that
 * cannot consume them. Confirmed sends drop the image parts.
 *
 * Source of truth (2026-04 snapshot):
 *   - Anthropic Claude 3+ family supports vision (3, 3.5, 3.7, 4, 4.5, 4.6, 4.7).
 *   - OpenAI: gpt-4o, gpt-4-turbo, gpt-4-vision, gpt-5* all support vision.
 *           o1, o1-mini, o3-mini reasoning models do NOT (text-only).
 *           gpt-3.5* does NOT.
 *   - Google Gemini 1.5 / 2.x family all support vision.
 *   - GitHub Copilot routes via OpenAI/Anthropic models — assume false unless
 *     model name matches a known vision-capable upstream.
 *   - Azure Foundry / Vertex AI — defer to underlying model name.
 */
import type { LLMVendor } from "./types.js";
import { isOpenAICompatibleVendor } from "../../shared/llm-vendor-defaults.js";
import type {
  MarketplaceInstalledProviderPreset,
  MarketplaceProviderPackageAsset,
} from "../../shared/marketplace-package-assets.js";

type ProviderPackageCapabilitySource =
  | Pick<MarketplaceInstalledProviderPreset, "capabilities">
  | Pick<MarketplaceProviderPackageAsset, "capabilities">
  | undefined;

const NON_VISION_MODEL_PATTERNS = [
  /^o1(-mini|-preview)?$/i,
  /^o3-mini/i,
  /^gpt-3\.5/i,
  /^text-/i,
  /^claude-2/i,
  /^claude-instant/i,
];

const VISION_MODEL_PATTERNS = [
  /^claude-/i,
  /^gpt-4(o|-turbo|-vision|\.5|\.6)/i,
  /^gpt-5/i,
  /^gemini-/i,
];

export function supportsVision(vendor: LLMVendor, model: string): boolean {
  const m = model.trim();
  if (m.length === 0) return false;

  for (const re of NON_VISION_MODEL_PATTERNS) {
    if (re.test(m)) return false;
  }

  for (const re of VISION_MODEL_PATTERNS) {
    if (re.test(m)) return true;
  }

  switch (vendor) {
    case "claude":
      return true;
    case "gemini":
    case "vertex-ai":
      return true;
    case "openai":
    case "azure-foundry":
      return /^(gpt-4|gpt-5|chatgpt)/i.test(m);
    case "copilot":
      return /^(gpt-4|gpt-5|claude-)/i.test(m);
    default:
      if (isOpenAICompatibleVendor(vendor)) {
        return /^(gpt-4|gpt-5|claude-|gemini-|qwen|kimi|glm|mimo|llama|meta-llama|nvidia\/)/i.test(m);
      }
      // Defense-in-depth: callers occasionally `as LLMVendor`-cast a raw
      // string (settings load, IPC inputs). An unexpected vendor would
      // otherwise yield undefined at runtime and violate the declared
      // boolean return — fall back to "no vision" rather than silently
      // surfacing as falsey.
      return false;
  }
}

/**
 * finish_reason=length CONTINUATION capability. When a round ends truncated
 * (stopReason "max_tokens") the conversation loop re-invokes the model to
 * CONTINUE the partial answer instead of showing it cut off. The mechanism is
 * vendor-specific; v1 ships only the vLLM/openai-compatible path (native
 * `continue_final_message`, zero-seam). Other vendors fall back to the existing
 * truncation notice until their prefill path is wired:
 *   - claude  → assistant-prefill (blocked while extended thinking is ON)
 *   - openai/gemini/copilot/azure-foundry/vertex → append partial + "continue"
 *     user reprompt + host stitch
 * This predicate is the SINGLE seam: extend it (and add the matching adapter
 * branch) to light up another vendor.
 */
export function vendorSupportsLengthContinuation(vendor: LLMVendor): boolean {
  return vendor === "openai-compatible";
}

export function providerPackageSupportsReviewerAdapter(
  metadata: ProviderPackageCapabilitySource,
): boolean {
  return metadata?.capabilities?.reviewerAdapter === true;
}
