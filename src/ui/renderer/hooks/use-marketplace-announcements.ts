import { useCallback, useEffect, useRef, useState } from "react";
import { isIpcErrorResult, type LvisApi } from "../types.js";
import type { MarketplaceAnnouncement } from "../../../shared/marketplace-announcements.js";

export type { MarketplaceAnnouncement } from "../../../shared/marketplace-announcements.js";

function normalizeDismissedAnnouncementIds(ids: Iterable<unknown>): number[] {
  const validIds = new Set<number>();
  for (const id of ids) {
    if (typeof id === "number" && Number.isSafeInteger(id)) {
      validIds.add(id);
    }
  }
  return Array.from(validIds).sort((a, b) => a - b);
}

/**
 * Subscribes to `MARKETPLACE.announcements` IPC events and exposes the active
 * announcement set plus a `dismiss(id)` callback.
 *
 * Dismissal removes the banner from local state immediately and persists the id
 * to `settings.marketplace.dismissedAnnouncementIds`. The host filters dismissed
 * ids out of every subsequent push (and across restarts), so a dismissed banner
 * never returns. Because `updateSettings` replaces the marketplace block's array
 * wholesale, the current ids are read first and merged.
 */
export function useMarketplaceAnnouncements(api: LvisApi) {
  const [announcements, setAnnouncements] = useState<MarketplaceAnnouncement[]>(
    [],
  );
  const dismissedIdsRef = useRef(new Set<number>());
  const dismissWriteRef = useRef(Promise.resolve());

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onMarketplaceAnnouncements((incoming) => {
      if (!alive) return;
      setAnnouncements(
        incoming.filter((announcement) =>
          !dismissedIdsRef.current.has(announcement.id),
        ),
      );
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const dismiss = useCallback(
    async (id: number) => {
      setAnnouncements((prev) => prev.filter((a) => a.id !== id));
      dismissedIdsRef.current.add(id);
      const nextWrite = dismissWriteRef.current.catch(() => {}).then(async () => {
        const settings = await api.getSettings();
        const existingRaw = settings.marketplace?.dismissedAnnouncementIds;
        const existing = Array.isArray(existingRaw) ? existingRaw : [];
        const existingDismissedIds = normalizeDismissedAnnouncementIds(existing);
        const nextDismissedIds = normalizeDismissedAnnouncementIds([
          ...existingDismissedIds,
          ...dismissedIdsRef.current,
        ]);
        if (
          nextDismissedIds.length === existingDismissedIds.length &&
          nextDismissedIds.every((dismissedId, index) =>
            dismissedId === existingDismissedIds[index],
          )
        ) {
          return;
        }
        const updateResult = await api.updateSettings({
          marketplace: { dismissedAnnouncementIds: nextDismissedIds },
        });
        if (isIpcErrorResult(updateResult)) {
          throw new Error(updateResult.message ?? updateResult.error);
        }
      });
      dismissWriteRef.current = nextWrite.catch(() => {});
      await nextWrite;
    },
    [api],
  );

  return { announcements, dismiss };
}
