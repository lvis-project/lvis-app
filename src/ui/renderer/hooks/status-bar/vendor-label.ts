import { t } from "../../../../i18n/runtime.js";
import { STATUS_BAR_VENDOR_EMOJIS } from "../../../../shared/status-bar-emojis.js";
import { isLLMVendor } from "../../../../shared/llm-vendor-defaults.js";
import { getVendorOption } from "../../constants.js";

/**
 * Short vendor name shown in the status sub-row — kept under ~12 chars so the
 * full "vendor · model" string fits in narrow windows.
 *
 * Only the long core names are shortened here. Every other known vendor takes
 * the name the chooser and the composer's model card already give it, so the
 * row's tooltip cannot call a provider something the card does not. A provider
 * id this build has no metadata for — a newer vendor read back from persisted
 * settings — is shown as the id itself rather than as some other vendor's name.
 */
export function shortVendorLabel(provider: string): string {
  switch (provider) {
    case "claude":
      return "Claude";
    case "openai":
      return "OpenAI";
    case "gemini":
      return "Gemini";
    case "copilot":
      return "Copilot";
    case "azure-foundry":
      return "Azure";
    case "vertex-ai":
      return "Vertex";
    default:
      if (!provider) return t("useStatusBarVendor.notConfigured");
      return isLLMVendor(provider) ? getVendorOption(provider).label : provider;
  }
}

/**
 * Vendor glyph — universal emoji so the indicator renders even on minimal font
 * stacks. Picked to match each vendor's brand color/identity at a glance.
 */
export function vendorEmoji(provider: string): string {
  switch (provider) {
    case "claude":
      return STATUS_BAR_VENDOR_EMOJIS.claude;
    case "openai":
      return STATUS_BAR_VENDOR_EMOJIS.openai;
    case "gemini":
      return STATUS_BAR_VENDOR_EMOJIS.gemini;
    case "copilot":
      return STATUS_BAR_VENDOR_EMOJIS.copilot;
    case "azure-foundry":
      return STATUS_BAR_VENDOR_EMOJIS.azureFoundry;
    case "vertex-ai":
      return STATUS_BAR_VENDOR_EMOJIS.vertexAi;
    default:
      return STATUS_BAR_VENDOR_EMOJIS.fallback;
  }
}
