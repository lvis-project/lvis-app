import { useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import type { AppBootstrapStatus } from "../../../shared/bootstrap-status.js";

/**
 * Managed bootstrap status subscription.
 *
 * The host emits one of three lifecycle states around
 * `ensureManagedInstalled()`:
 *   - `start`       — install pipeline kicked off; render a quiet spinner
 *   - `complete`    — finished; expose `installed` + `failed` + `skippedReason`
 *                     so the UI can render "all set", "N failed", or
 *                     "marketplace not configured" depending on shape
 *   - `error`       — bootstrap itself threw; expose `message` for the banner
 *
 * `installing` is a derived flag (true between start and complete/error).
 * Renderer can debounce / dismiss on its own; the hook never auto-clears.
 *
 * On a cold boot every one of those events is emitted before this renderer
 * loads, so the subscription alone would show nothing at first launch — the
 * exact failure the pill exists to report. The hook therefore also pulls the
 * host's recorded snapshot on mount. A live event always wins: the pull is
 * applied only while none has arrived, so a stale snapshot resolving late can
 * never overwrite a newer event.
 */
export interface BootstrapStatusState {
  status: AppBootstrapStatus | null;
  /** True between `start` and a terminal (complete/error) event. */
  installing: boolean;
}

export function useBootstrapStatus(
  api: LvisApi,
): BootstrapStatusState & { dismiss: () => void; retry: () => Promise<void> } {
  const [status, setStatus] = useState<AppBootstrapStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const liveEventRef = useRef(false);

  useEffect(() => {
    let alive = true;
    liveEventRef.current = false;
    // Subscribe first: an event emitted while the pull is in flight must be
    // seen, and must be the one that survives.
    const unsubscribe = api.onBootstrapStatus((next) => {
      if (!alive) return;
      liveEventRef.current = true;
      setStatus(next);
      setInstalling(next.phase === "start");
    });
    void api
      .getBootstrapStatus()
      .then((snapshot) => {
        if (!alive || liveEventRef.current || !snapshot) return;
        setStatus(snapshot);
        setInstalling(snapshot.phase === "start");
      })
      .catch(() => {
        /* no snapshot — the subscription still covers every later event */
      });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  return {
    status,
    installing,
    dismiss: () => setStatus(null),
    // The host re-emits start/complete/error during the retry, so the hook
    // doesn't need to mutate `status` itself — let the IPC subscription
    // drive the banner update.
    retry: async () => {
      try {
        await api.retryBootstrap();
      } catch {
        /* the host's error event will surface via onBootstrapStatus */
      }
    },
  };
}
