import { useCallback, useEffect, useRef, useState } from "react";
import { isIpcErrorResult, type LvisApi, type MarketplaceItem } from "../types.js";

export interface PluginUpdateInfo {
  pluginId: string;
  pluginName?: string;
  installedVersion: string;
  latestVersion: string;
  networkAccess?: MarketplaceItem["networkAccess"];
}

const RESERVED_SKIPPED_UPDATE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function useMarketplaceUpdates(api: LvisApi) {
  const [updates, setUpdates] = useState<PluginUpdateInfo[]>([]);
  const updatesRef = useRef<PluginUpdateInfo[]>([]);
  const skippedUpdatesRef = useRef<Record<string, string>>(createSkippedPluginUpdateMap());
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
        skippedUpdatesRef.current = normalizeSkippedPluginUpdates(
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

  const skip = useCallback(async () => {
    const visibleUpdates = updatesRef.current;
    if (visibleUpdates.length === 0) return;

    const nextWrite = skipWriteRef.current.catch(() => {}).then(async () => {
      try {
        const settings = await api.getSettings();
        const existingSkipped = normalizeSkippedPluginUpdates(
          settings.marketplace?.skippedPluginUpdates,
        );
        const nextSkipped = copySkippedPluginUpdates(existingSkipped);
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

  return { updates, dismiss, skip };
}

function normalizeSkippedPluginUpdates(input: unknown): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return createSkippedPluginUpdateMap();
  }
  return copySkippedPluginUpdates(input as Record<string, unknown>);
}

function copySkippedPluginUpdates(input: Record<string, unknown>): Record<string, string> {
  const normalized = createSkippedPluginUpdateMap();
  for (const [pluginId, version] of Object.entries(input)) {
    if (typeof version !== "string") continue;
    putSkippedPluginUpdate(normalized, pluginId, version);
  }
  return normalized;
}

function createSkippedPluginUpdateMap(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

function putSkippedPluginUpdate(
  target: Record<string, string>,
  pluginId: string,
  latestVersion: string,
): void {
  const key = normalizeSkippedPluginUpdateKey(pluginId);
  const value = latestVersion.trim();
  if (!key || !value) return;
  target[key] = value;
}

function normalizeSkippedPluginUpdateKey(pluginId: string): string | null {
  const key = pluginId.trim();
  if (!key || RESERVED_SKIPPED_UPDATE_KEYS.has(key)) return null;
  return key;
}

function filterSkippedUpdates(
  updates: PluginUpdateInfo[],
  skipped: Record<string, string>,
): PluginUpdateInfo[] {
  return updates.filter((update) => {
    const key = normalizeSkippedPluginUpdateKey(update.pluginId);
    const version = update.latestVersion.trim();
    return !key || !version || skipped[key] !== version;
  });
}

function sameSkippedPluginUpdates(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}
