import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * Double-click guard: `inFlight` ref tracks an outstanding IPC so rapid
 * badge re-clicks don't queue multiple `downloadUpdate()` invocations
 * during the IPC round-trip window before the main process broadcasts
 * the next state. Cleared automatically when the next state arrives.
 *
 * Destructive-action confirmation: `install()` prompts the user before
 * quitting the app, since `quitAndInstall()` aborts unsaved chat /
 * in-flight LLM streams / plugin work with no recovery.
 */
export function useAppUpdate(api: LvisApi): {
  state: AppUpdateBadgeState;
  inFlight: boolean;
  download: () => Promise<void>;
  install: () => Promise<void>;
} {
  const [state, setState] = useState<AppUpdateBadgeState>({ kind: "idle" });
  const [inFlight, setInFlight] = useState(false);
  const inFlightRef = useRef(false);

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
      // State broadcast = main process accepted (or progressed past) our
      // last in-flight action. Clear the gate so subsequent clicks (e.g.,
      // retry after error) are not silently blocked.
      if (inFlightRef.current) {
        inFlightRef.current = false;
        setInFlight(false);
      }
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  const download = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      await api.downloadAppUpdate();
    } catch {
      // Main-side logs warn; on rejection we release the gate so the user
      // can retry. State broadcast normally clears this — only matters on
      // a hard IPC failure where no state change arrives.
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [api]);

  const install = useCallback(async () => {
    if (inFlightRef.current) return;
    // Destructive: app will quit and replace itself. Confirm before firing
    // so users with unsaved composer text / in-flight LLM streams have a
    // chance to cancel. `confirm()` is synchronous and browser-blocking,
    // matching the gravity of the action — quitAndInstall is irreversible.
    const version = state.kind === "downloaded" ? state.version : "";
    const ok = window.confirm(
      version
        ? `LVIS v${version} 으로 재시작합니다. 진행 중인 작업이 종료됩니다. 계속하시겠습니까?`
        : "업데이트를 적용하고 재시작합니다. 진행 중인 작업이 종료됩니다. 계속하시겠습니까?",
    );
    if (!ok) return;
    inFlightRef.current = true;
    setInFlight(true);
    try {
      await api.installAppUpdate();
    } catch {
      inFlightRef.current = false;
      setInFlight(false);
    }
  }, [api, state]);

  return { state, inFlight, download, install };
}
