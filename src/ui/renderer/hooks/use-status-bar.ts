import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { LONG_TOAST_TTL_MS } from "../constants.js";
import type { PersistentItem, ToastItem } from "./status-bar/types.js";
import { useStatusBarNotifications } from "./status-bar/use-status-bar-notifications.js";
import { useStatusBarInstall } from "./status-bar/use-status-bar-install.js";
import { useStatusBarRuntime } from "./status-bar/use-status-bar-runtime.js";
import { useStatusBarMarketplace } from "./status-bar/use-status-bar-marketplace.js";
import { useStatusBarOs } from "./status-bar/use-status-bar-os.js";

// Re-export shared types so existing call sites (App.tsx, StatusBar.tsx, tests)
// continue to import from this module without changes.
export type { StatusBarSeverity, NotificationToastMeta, PersistentItem, ToastItem } from "./status-bar/types.js";

/**
 * Status-bar event surface shared between persistent (left slot) and
 * transient (right slot) items. The bottom status bar (#231) reads from
 * this hook; producers subscribe to host events that already exist
 * (install-progress, install-result, uninstall-result) plus the routine
 * schedule from settings, so this hook needs no new IPC channel for the
 * Phase 1 surface.
 *
 * Future phases (plugin-emitted events, online/offline, marketplace
 * reachability) will plug into the same hook by appending toasts /
 * upserting persistent items — see issue #231.
 */

interface UseStatusBarOptions {
  api: LvisApi;
  /**
   * Default toast TTL in milliseconds. Override per-toast at push time.
   * Defaults to LONG_TOAST_TTL_MS (5 s) — long enough to read a single
   * Korean sentence, short enough to feel ephemeral.
   */
  defaultToastTtlMs?: number;
}

/**
 * Hard cap on the toast queue. Prevents an event burst (e.g. 100 install
 * events in one tick) from growing state unbounded between eviction sweeps.
 * The on-screen render only shows the latest 3; capping at 50 leaves
 * generous headroom while bounding memory + re-render cost.
 */
const TOAST_QUEUE_CAP = 50;

export function useStatusBar(opts: UseStatusBarOptions) {
  // LONG_TOAST_TTL_MS (5 s) gives comfortable reading time for a Korean
  // phrase; callers that need a shorter or longer window pass defaultToastTtlMs.
  const { api, defaultToastTtlMs = LONG_TOAST_TTL_MS } = opts;
  const [persistent, setPersistent] = useState<PersistentItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Stable counter for unique toast IDs without leaning on Date.now()
  // (which collides under quick successive pushes).
  const toastCounterRef = useRef(0);

  const pushToast = useCallback(
    (input: {
      severity: ToastItem["severity"];
      message: string;
      ttlMs?: number;
      notification?: ToastItem["notification"];
    }) => {
      const id = `toast:${++toastCounterRef.current}`;
      const expiresAt = Date.now() + (input.ttlMs ?? defaultToastTtlMs);
      setToasts((prev) => {
        const newItem: ToastItem = {
          id,
          severity: input.severity,
          message: input.message,
          expiresAt,
          notification: input.notification,
        };
        if (prev.length >= TOAST_QUEUE_CAP) {
          return [...prev.slice(prev.length - TOAST_QUEUE_CAP + 1), newItem];
        }
        return [...prev, newItem];
      });
      return id;
    },
    [defaultToastTtlMs],
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // ── Sequential toast display: auto-advance queue head after its TTL.
  // Only the queue head (toasts[0]) is exposed as `visibleToast`. When the
  // head's TTL elapses (or removeToast dismisses it early), the next item
  // in the queue becomes the new head and gets its own timer. This prevents
  // a burst of install-result events from rendering multiple toasts at once.
  const visibleToast = toasts[0] ?? null;
  useEffect(() => {
    if (visibleToast === null) return;
    const delay = Math.max(0, visibleToast.expiresAt - Date.now());
    const id = setTimeout(() => {
      setToasts((prev) => (prev[0]?.id === visibleToast.id ? prev.slice(1) : prev));
    }, delay);
    return () => clearTimeout(id);
  }, [visibleToast]);

  const upsertPersistent = useCallback((item: PersistentItem) => {
    setPersistent((prev) => {
      const idx = prev.findIndex((p) => p.id === item.id);
      if (idx === -1) return [...prev, item];
      const next = [...prev];
      next[idx] = item;
      return next;
    });
  }, []);

  const removePersistent = useCallback((id: string) => {
    setPersistent((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── Producers (each in its own file under status-bar/)
  useStatusBarNotifications({ api, pushToast });
  useStatusBarInstall({ api, pushToast });
  useStatusBarRuntime({ api, upsertPersistent });
  useStatusBarMarketplace({ api, upsertPersistent, removePersistent });
  useStatusBarOs({ api, upsertPersistent });

  return {
    persistent,
    toasts,
    /** The single toast currently visible in the status bar (queue head). */
    visibleToast,
    /** Number of queued toasts waiting behind the visible one. */
    pendingCount: Math.max(0, toasts.length - 1),
    pushToast,
    removeToast,
    upsertPersistent,
    removePersistent,
  };
}
