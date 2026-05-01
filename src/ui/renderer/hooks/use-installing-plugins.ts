/**
 * Tracks the set of plugin IDs currently being installed.
 *
 * Subscribes to the existing `onPluginInstallProgress` / `onPluginInstallResult`
 * IPC events (same events consumed by `useStatusBar` and `usePluginMarketplace`)
 * and returns a `Set<string>` of plugin slugs currently in-flight. The set
 * grows on progress events and shrinks on result events (both success and
 * failure).
 *
 * No new IPC channels — relies on the existing install event surface.
 */
import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

export function useInstallingPlugins(api: LvisApi): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress((payload) => {
          setIds((prev) => {
            if (prev.has(payload.slug)) return prev;
            const next = new Set(prev);
            next.add(payload.slug);
            return next;
          });
        }),
      );
    }

    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult((payload) => {
          setIds((prev) => {
            if (!prev.has(payload.slug)) return prev;
            const next = new Set(prev);
            next.delete(payload.slug);
            return next;
          });
        }),
      );
    }

    return () => {
      for (const u of unsubs) u();
    };
  }, [api]);

  return ids;
}
