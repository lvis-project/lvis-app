import { useCallback, useEffect, useRef, useState } from "react";
import { isIpcErrorResult, type LvisApi, type MarketplaceItem } from "../types.js";
import {
  createSkippedPluginUpdateMap,
  isSkippedPluginUpdate,
  putSkippedPluginUpdate,
  readSkippedPluginUpdates,
  type SkippedPluginUpdateMap,
} from "../../../shared/skipped-plugin-updates.js";

export interface PluginUpdateInfo {
  pluginId: string;
  pluginName?: string;
  installedVersion: string;
  latestVersion: string;
  networkAccess?: MarketplaceItem["networkAccess"];
}

export function useMarketplaceUpdates(api: LvisApi) {
  const [updates, setUpdates] = useState<PluginUpdateInfo[]>([]);
  const updatesRef = useRef<PluginUpdateInfo[]>([]);
  const skippedUpdatesRef = useRef<SkippedPluginUpdateMap>(createSkippedPluginUpdateMap());
  const skipWriteRef = useRef(Promise.resolve());

  const replaceUpdates = useCallback((next: PluginUpdateInfo[]) => {
    updatesRef.current = next;
    setUpdates(next);
  }, []);

  useEffect(() => {
    let alive = true;
    void api
      .getSettings()
      .then((settings) => {
        if (!alive) return;
        skippedUpdatesRef.current = readSkippedPluginUpdates(
          settings.marketplace?.skippedPluginUpdates,
        );
        replaceUpdates(filterSkippedUpdates(updatesRef.current, skippedUpdatesRef.current));
      })
      .catch(() => {
        /* Host already filters persisted skips; settings fetch is a renderer-side fast path. */
      });
    const unsubscribe = api.onMarketplaceUpdatesAvailable((incoming) => {
      if (alive) replaceUpdates(filterSkippedUpdates(incoming, skippedUpdatesRef.current));
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api, replaceUpdates]);

  const dismiss = useCallback(() => {
    replaceUpdates([]);
  }, [replaceUpdates]);

  // Optimistically drop plugins that just updated successfully from the visible
  // banner list. Used by the banner's partial-failure path so succeeded rows
  // disappear while failed rows remain for retry. The host detector's next
  // `marketplace:updates-available` broadcast remains the reconciling SOT.
  const resolveUpdated = useCallback((pluginIds: string[]) => {
    if (pluginIds.length === 0) return;
    const resolved = new Set(pluginIds);
    replaceUpdates(updatesRef.current.filter((update) => !resolved.has(update.pluginId)));
  }, [replaceUpdates]);

  const skip = useCallback(async () => {
    const visibleUpdates = updatesRef.current;
    if (visibleUpdates.length === 0) return;

    const nextWrite = skipWriteRef.current.catch(() => {}).then(async () => {
      try {
        const settings = await api.getSettings();
        const existingSkipped = readSkippedPluginUpdates(
          settings.marketplace?.skippedPluginUpdates,
        );
        // `readSkippedPluginUpdates` is idempotent, so re-reading an already
        // normalized map is exactly the copy this needs — `existingSkipped`
        // must stay untouched for the no-change comparison below.
        const nextSkipped = readSkippedPluginUpdates(existingSkipped);
        for (const update of visibleUpdates) {
          putSkippedPluginUpdate(nextSkipped, update.pluginId, update.latestVersion);
        }
        if (sameSkippedPluginUpdates(existingSkipped, nextSkipped)) {
          skippedUpdatesRef.current = nextSkipped;
          replaceUpdates(filterSkippedUpdates(updatesRef.current, nextSkipped));
          return;
        }
        const updateResult = await api.updateSettings({
          marketplace: { skippedPluginUpdates: nextSkipped },
        });
        if (isIpcErrorResult(updateResult)) {
          return;
        }
        skippedUpdatesRef.current = nextSkipped;
        replaceUpdates(filterSkippedUpdates(updatesRef.current, nextSkipped));
      } catch {
        /* Skip persistence failure should not reject or create a renderer-only skip SOT. */
      }
    });
    skipWriteRef.current = nextWrite;
    await nextWrite;
  }, [api, replaceUpdates]);

  return { updates, dismiss, skip, resolveUpdated };
}

function filterSkippedUpdates(
  updates: PluginUpdateInfo[],
  skipped: SkippedPluginUpdateMap,
): PluginUpdateInfo[] {
  return updates.filter((update) => !isSkippedPluginUpdate(update, skipped));
}

function sameSkippedPluginUpdates(
  left: SkippedPluginUpdateMap,
  right: SkippedPluginUpdateMap,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
