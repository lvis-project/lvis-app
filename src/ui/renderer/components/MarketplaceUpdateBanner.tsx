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
  onUpdate: (pluginId: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (updates.length === 0) return null;

  const label =
    updates.length === 1
      ? `플러그인 업데이트 가능: ${updates[0].pluginId} → ${updates[0].latestVersion}`
      : `${updates.length}개 플러그인 업데이트 가능`;

  const handleUpdate = async () => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    for (const u of updates) {
      try {
        await onUpdate(u.pluginId);
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
      className="flex items-center justify-between gap-2 bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-2 rounded-md mx-2 mt-2"
      data-testid="marketplace-update-banner"
    >
      <span>
        {label}
        {error ? <span className="ml-2 text-rose-700">— 일부 실패: {error}</span> : null}
      </span>
      <div className="flex items-center gap-1">
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
          className="text-blue-700 hover:text-blue-900 h-auto p-1"
        >
          ✕
        </Button>
      </div>
    </div>
  );
}
