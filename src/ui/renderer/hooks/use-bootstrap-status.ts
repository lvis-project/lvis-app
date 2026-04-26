import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";

/**
 * Phase 2d — managed bootstrap status subscription.
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
 */
export type BootstrapStatusEvent =
  | { phase: "start" }
  | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
  | { phase: "error"; message: string };

export interface BootstrapStatusState {
  status: BootstrapStatusEvent | null;
  /** True between `start` and a terminal (complete/error) event. */
  installing: boolean;
}

export function useBootstrapStatus(api: LvisApi): BootstrapStatusState & { dismiss: () => void } {
  const [status, setStatus] = useState<BootstrapStatusEvent | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let alive = true;
    const unsubscribe = api.onBootstrapStatus((next) => {
      if (!alive) return;
      setStatus(next);
      setInstalling(next.phase === "start");
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
  };
}
