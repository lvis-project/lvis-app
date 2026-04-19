// S8 — Non-blocking, dismissible banner shown when plugin updates are available.

import { Button } from "../../../components/ui/button.js";
import type { PluginUpdateInfo } from "../hooks/use-marketplace-updates.js";

/**
 * Renders a compact banner listing plugins with available updates.
 * Displayed at the top of the app when `marketplace:updates-available` fires.
 * Dismissible — calling `onDismiss` hides it until the next IPC event.
 */
export function MarketplaceUpdateBanner({
  updates,
  onDismiss,
}: {
  updates: PluginUpdateInfo[];
  onDismiss: () => void;
}) {
  if (updates.length === 0) return null;

  const label =
    updates.length === 1
      ? `플러그인 업데이트 가능: ${updates[0].pluginId} → ${updates[0].latestVersion}`
      : `${updates.length}개 플러그인 업데이트 가능`;

  return (
    <div className="flex items-center justify-between gap-2 bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-2 rounded-md mx-2 mt-2">
      <span>{label}</span>
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
  );
}
