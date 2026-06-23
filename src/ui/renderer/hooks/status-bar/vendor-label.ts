import { t } from "../../../../i18n/runtime.js";
import { STATUS_BAR_VENDOR_EMOJIS } from "../../../../shared/status-bar-emojis.js";

/**
 * Short vendor name shown in the status sub-row — kept under ~12 chars so the
 * full "vendor · model" string fits in narrow windows. Falls back to the raw
 * provider id for an unknown vendor (a future vendor not yet in this table).
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
      return provider || t("useStatusBarVendor.notConfigured");
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
