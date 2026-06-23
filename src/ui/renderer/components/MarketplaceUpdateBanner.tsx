// S8 — Non-blocking banner shown when plugin updates are available.

import { useState } from "react";
import { X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import type { PluginUpdateInfo } from "../hooks/use-marketplace-updates.js";
import { MarqueeText } from "./MarqueeText.js";
import { useTranslation } from "../../../i18n/react.js";

/**
 * Renders a compact banner listing plugins with available updates.
 * Displayed at the top of the app when `marketplace:updates-available` fires.
 * Skipping persists the visible plugin versions until a newer version appears.
 *
 * "업데이트" button installs each pluginId in sequence via `onUpdate`
 * (the marketplace install endpoint replaces the existing version). After all
 * updates finish the banner clears locally; failures keep the banner visible
 * with the partial-failure message.
 */
export function MarketplaceUpdateBanner({
  updates,
  onDismiss,
  onSkip,
  onUpdate,
}: {
  updates: PluginUpdateInfo[];
  onDismiss: () => void;
  onSkip: () => void | Promise<void>;
  onUpdate: (pluginId: string, expectedVersion?: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (updates.length === 0) return null;

  const updateLabels = updates.map((update) => formatUpdateLabel(update));
  const summary =
    updates.length === 1
      ? t("marketplaceUpdateBanner.summaryOne")
      : t("marketplaceUpdateBanner.summaryMany", { count: updates.length });
  const details = updateLabels.join(", ");
  const label = `${summary} ${details}`;

  const handleUpdate = async () => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const u of updates) {
      try {
        await onUpdate(u.pluginId, u.latestVersion);
      } catch (e) {
        failures.push(`${u.pluginId}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    if (failures.length === 0) {
      onDismiss();
    } else {
      setError(failures.join("; "));
    }
  };

  return (
    <div
      className="flex h-11 items-center justify-between gap-2 overflow-hidden bg-popover border border-info/(--opacity-medium) text-info text-sm px-4 py-1.5 rounded-md mx-2 mt-2 shadow-lg lvis-anim-slide-down"
      data-testid="marketplace-update-banner"
    >
      <span className="min-w-0 flex-1" title={label}>
        <span className="block truncate leading-4">{summary}</span>
        <MarqueeText text={details} className="text-[11px] leading-3 text-info/(--opacity-emphatic)" />
        {error ? <span className="ml-2 text-destructive">{t("marketplaceUpdateBanner.partialFailure", { error })}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="default"
          size="sm"
          onClick={() => void handleUpdate()}
          disabled={busy}
          data-testid="marketplace-update-action"
          className="h-7 text-[12px]"
        >
          {busy ? t("marketplaceUpdateBanner.updating") : t("marketplaceUpdateBanner.updateButton")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void onSkip()}
          disabled={busy}
          aria-label={t("marketplaceUpdateBanner.skipAriaLabel")}
          title={t("marketplaceUpdateBanner.skipTitle")}
          className="text-info hover:text-info/(--opacity-intense) h-auto p-1"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function formatUpdateLabel(update: PluginUpdateInfo): string {
  const displayName = update.pluginName?.trim() || update.pluginId;
  const name =
    displayName === update.pluginId ? displayName : `${displayName} (${update.pluginId})`;
  return `${name} → ${update.latestVersion}`;
}
