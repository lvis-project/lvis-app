import { useEffect } from "react";
import { t } from "../../../../i18n/runtime.js";
import { STATUS_BAR_VENDOR_EMOJIS } from "../../../../shared/status-bar-emojis.js";
import type { LvisApi, AppSettings } from "../../types.js";
import type { PersistentItem } from "./types.js";

interface Options {
  api: LvisApi;
  upsertPersistent: (item: PersistentItem) => void;
}

/**
 * Vendor + model indicator for the status bar.
 *
 * Surfaces the currently active LLM provider and model name from
 * `settings.llm`. Reads once at mount via `getSettings()` and stays
 * reactive through `onSettingsUpdated`, so flipping the provider in
 * Settings → LLM immediately reflects in the status bar.
 *
 * The cell is a single `vendor:llm` persistent item that renders the
 * vendor glyph plus a short "vendor · model" string. Clicking it opens
 * Settings → LLM via `api.openSettingsWindow("llm")` so users can change
 * vendor/model without hunting the gear icon. When `openSettingsWindow`
 * is unavailable (e.g. detached preview windows that omit the API), the
 * cell still renders but stays unclickable.
 */
export function useStatusBarVendor({ api, upsertPersistent }: Options): void {
  useEffect(() => {
    if (typeof api.getSettings !== "function") return;
    let cancelled = false;

    const apply = (settings: AppSettings) => {
      if (cancelled) return;
      const provider = settings.llm?.provider ?? "";
      const vendorBlock = settings.llm?.vendors?.[provider];
      const model = vendorBlock?.model ?? "";
      const vendorLabel = shortVendorLabel(provider);
      const value = model.length > 0 ? `${vendorLabel} · ${model}` : vendorLabel;
      const onClick =
        typeof api.openSettingsWindow === "function"
          ? () => {
              void api.openSettingsWindow?.("llm");
            }
          : undefined;
      upsertPersistent({
        id: "vendor:llm",
        severity: "info",
        label: vendorEmoji(provider),
        value,
        a11yLabel: t("useStatusBarVendor.activeVendorA11y"),
        tooltip: model.length > 0 ? `${vendorLabel} · ${model}` : vendorLabel,
        onClick,
      });
    };

    void api
      .getSettings()
      .then((settings) => {
        apply(settings);
      })
      .catch(() => {
        // Non-fatal — the indicator is awareness-only.
      });

    const unsubs: Array<() => void> = [];
    if (typeof api.onSettingsUpdated === "function") {
      unsubs.push(api.onSettingsUpdated((next) => apply(next)));
    }

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api, upsertPersistent]);
}

/**
 * Short vendor name shown in the status bar — kept under ~12 chars so the
 * full "vendor · model" string fits in narrow (460px) windows. Falls back
 * to the raw provider id when an unknown vendor is supplied (e.g. a
 * future vendor not yet added to the labels table).
 */
function shortVendorLabel(provider: string): string {
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
 * Vendor glyph — universal emoji so the indicator renders even on minimal
 * font stacks. Picked to match each vendor's brand color/identity at a
 * glance without licensing real logos.
 */
function vendorEmoji(provider: string): string {
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
