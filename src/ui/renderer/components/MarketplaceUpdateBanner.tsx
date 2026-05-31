// S8 — Non-blocking, dismissible banner shown when plugin updates are available.

import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import type { PluginUpdateInfo } from "../hooks/use-marketplace-updates.js";

/**
 * Renders a compact banner listing plugins with available updates.
 * Displayed at the top of the app when `marketplace:updates-available` fires.
 * Dismissible — calling `onDismiss` hides it until the next IPC event.
 *
 * "업데이트" button installs each pluginId in sequence via `onUpdate`
 * (the marketplace install endpoint replaces the existing version). After all
 * updates finish the banner self-dismisses; failures keep the banner visible
 * with the partial-failure message.
 */
export function MarketplaceUpdateBanner({
  updates,
  onDismiss,
  onUpdate,
}: {
  updates: PluginUpdateInfo[];
  onDismiss: () => void;
  onUpdate: (pluginId: string, expectedVersion?: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (updates.length === 0) return null;

  const updateLabels = updates.map((update) => formatUpdateLabel(update));
  const summary =
    updates.length === 1
      ? "플러그인 업데이트 가능:"
      : `${updates.length}개 플러그인 업데이트 가능:`;
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
      className="flex h-11 items-center justify-between gap-2 overflow-hidden bg-info/15 border border-info/40 text-info text-sm px-4 py-1.5 rounded-md mx-2 mt-2 lvis-anim-slide-down"
      data-testid="marketplace-update-banner"
    >
      <span className="min-w-0 flex-1" title={label}>
        <span className="block truncate leading-4">{summary}</span>
        <span className="block truncate text-[11px] leading-3 text-info/75">{details}</span>
        {error ? <span className="ml-2 text-destructive">— 일부 실패: {error}</span> : null}
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
          {busy ? "업데이트 중…" : "업데이트"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          aria-label="업데이트 알림 닫기"
          className="text-info hover:text-info/80 h-auto p-1"
        >
          ✕
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
