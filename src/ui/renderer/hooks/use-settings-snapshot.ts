/**
 * Seed a settings-backed surface from `getSettings()` once, then follow every
 * `onSettingsUpdated` broadcast with the same handler.
 *
 * Its own leaf because more than one settings tab subscribes this way and one
 * did not: the marketplace-URL reader took a single snapshot, so a URL changed
 * from another window, or by the first load resolving late, never reached it.
 * A surface that reads settings follows them; this hook is where that rule is
 * spelled out once.
 *
 * `applySnapshot` must be referentially stable (`useCallback`) — it is the
 * subscription's dependency, and a new identity per render would resubscribe
 * and re-seed on every commit.
 */
import { useEffect } from "react";
import type { AppSettings, LvisApi } from "../types.js";

export type SettingsSnapshotApi = Pick<LvisApi, "getSettings" | "onSettingsUpdated">;

export function useSettingsSnapshot(
  api: SettingsSnapshotApi,
  applySnapshot: (settings: AppSettings) => void,
): void {
  useEffect(() => {
    let alive = true;
    void api.getSettings().then((s) => { if (alive) applySnapshot(s); });
    const unsub = api.onSettingsUpdated((s) => applySnapshot(s));
    return () => { alive = false; unsub(); };
  }, [api, applySnapshot]);
}
