import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import type { AppUpdateBadgeState } from "../MainToolbar.js";

const INSTALL_HANDOFF_SAFETY_RELEASE_MS = 10_000;

/**
 * Subscribes to `api.onAppUpdateState` for the lifetime of the app and
 * exposes click-action handlers for the toolbar badge. The hook is
 * deliberately tiny (no internal caching beyond the active state) — the
 * main process is the SoT and pushes every transition.
 *
 * Initial state is fetched via `api.getAppUpdateState()` so a late mount
 * (renderer reload, etc.) catches up to whatever the main process has
 * already broadcast.
 *
 * Double-click guard: `inFlight` ref tracks an outstanding IPC so rapid
 * badge re-clicks don't queue multiple `downloadUpdate()` invocations
 * during the IPC round-trip window before the main process broadcasts
 * the next state. Cleared automatically when the next state arrives.
 *
 * Destructive-action confirmation is owned by the main process inside
 * `lvis:update:install-now`. Keeping the native dialog and install trigger
 * in one IPC handler prevents a renderer caller from skipping confirmation.
 */
export function useAppUpdate(api: LvisApi): {
  state: AppUpdateBadgeState;
  inFlight: boolean;
  download: () => Promise<void>;
  install: () => Promise<void>;
  skip: () => Promise<void>;
} {
  const [state, setState] = useState<AppUpdateBadgeState>({ kind: "idle" });
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);
  const hasLiveStateRef = useRef(false);
  const installSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearInstallSafetyTimer = useCallback(() => {
    if (installSafetyTimerRef.current === null) return;
    clearTimeout(installSafetyTimerRef.current);
    installSafetyTimerRef.current = null;
  }, []);

  const releaseInFlight = useCallback(() => {
    clearInstallSafetyTimer();
    inFlightRef.current = false;
    setInFlight(false);
  }, [clearInstallSafetyTimer]);

  const scheduleInstallSafetyRelease = useCallback(() => {
    clearInstallSafetyTimer();
    installSafetyTimerRef.current = setTimeout(() => {
      releaseInFlight();
    }, INSTALL_HANDOFF_SAFETY_RELEASE_MS);
  }, [clearInstallSafetyTimer, releaseInFlight]);

  useEffect(() => {
    let alive = true;
    hasLiveStateRef.current = false;
    const unsubscribe = api.onAppUpdateState((next) => {
      hasLiveStateRef.current = true;
      setState(next);
      // State broadcast = main process accepted (or progressed past) our
      // last in-flight action. Clear the gate so subsequent clicks (e.g.,
      // retry after error) are not silently blocked.
      if (inFlightRef.current) {
        releaseInFlight();
      }
    });
    void api
      .getAppUpdateState()
      .then((s) => {
        if (alive && !hasLiveStateRef.current) setState(s);
      })
      .catch(() => {
        /* state stays idle — non-fatal */
      });
    return () => {
      alive = false;
      clearInstallSafetyTimer();
      unsubscribe();
    };
  }, [api, clearInstallSafetyTimer, releaseInFlight]);

  const download = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.downloadAppUpdate();
      if (!result.ok) {
        releaseInFlight();
      }
    } catch {
      // Main-side logs warn; on rejection we release the gate so the user
      // can retry. State broadcast normally clears this — only matters on
      // a hard IPC failure where no state change arrives.
      releaseInFlight();
    }
  }, [api, releaseInFlight]);

  const install = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.installAppUpdate();
      if (!result.ok) {
        releaseInFlight();
        return;
      }
      // Keep the gate locked while the updater-owned shutdown handoff is
      // expected to close the app. If the app remains alive, release after a
      // bounded delay so the badge cannot stay disabled forever.
      scheduleInstallSafetyRelease();
    } catch {
      releaseInFlight();
    }
  }, [api, releaseInFlight, scheduleInstallSafetyRelease]);

  const skip = useCallback(async () => {
    if (inFlightRef.current) return;
    if (state.kind !== "available" && state.kind !== "downloaded") return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      const result = await api.skipAppUpdate();
      if (!result.ok) {
        releaseInFlight();
      }
    } catch {
      releaseInFlight();
    }
  }, [api, releaseInFlight, state.kind]);

  return { state, inFlight, download, install, skip };
}
