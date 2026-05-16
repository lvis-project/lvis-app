import { useCallback, useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import type { AppUpdateBadgeState } from "../MainToolbar.js";

/**
 * Subscribes to `api.onAppUpdateState` for the lifetime of the app and
 * exposes click-action handlers for the toolbar badge. The hook is
 * deliberately tiny (no internal caching beyond the active state) — the
 * main process is the SoT and pushes every transition.
 *
 * Initial state is fetched via `api.getAppUpdateState()` so a late mount
 * (renderer reload, etc.) catches up to whatever the main process has
 * already broadcast.
 */
export function useAppUpdate(api: LvisApi): {
  state: AppUpdateBadgeState;
  download: () => Promise<void>;
  install: () => Promise<void>;
} {
  const [state, setState] = useState<AppUpdateBadgeState>({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    void api
      .getAppUpdateState()
      .then((s) => {
        if (alive) setState(s);
      })
      .catch(() => {
        /* state stays idle — non-fatal */
      });
    const unsubscribe = api.onAppUpdateState((next) => {
      setState(next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const download = useCallback(async () => {
    try {
      await api.downloadAppUpdate();
    } catch {
      /* main-side logs warn; renderer stays passive */
    }
  }, [api]);

  const install = useCallback(async () => {
    try {
      await api.installAppUpdate();
    } catch {
      /* main-side logs warn; renderer stays passive */
    }
  }, [api]);

  return { state, download, install };
}
