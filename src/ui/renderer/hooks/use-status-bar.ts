import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { LONG_TOAST_TTL_MS } from "../constants.js";
import type { PersistentItem, ToastItem } from "./status-bar/types.js";
import { useStatusBarNotifications } from "./status-bar/use-status-bar-notifications.js";
import { useStatusBarInstall } from "./status-bar/use-status-bar-install.js";
import { useStatusBarVendor } from "./status-bar/use-status-bar-vendor.js";
import { useStatusBarHealth } from "./status-bar/use-status-bar-health.js";
import { useStatusBarPermission } from "./status-bar/use-status-bar-permission.js";

// Re-export shared types so existing call sites (App.tsx, StatusBar.tsx, tests)
// continue to import from this module without changes.
export type { StatusBarSeverity, NotificationToastMeta, PersistentItem, ToastItem } from "./status-bar/types.js";

/**
 * Compare two persistent items by their display-relevant fields only. The
 * `onClick` handler is intentionally excluded: producers may build a fresh
 * closure on every run, but a changed handler identity must not be treated as
 * a state change (that would defeat the loop guard in `upsertPersistent`).
 */
function samePersistentDisplay(a: PersistentItem, b: PersistentItem): boolean {
  return (
    a.id === b.id &&
    a.severity === b.severity &&
    a.label === b.label &&
    a.value === b.value &&
    a.dot === b.dot &&
    a.a11yLabel === b.a11yLabel &&
    a.tooltip === b.tooltip
  );
}

/**
 * Status-bar event surface shared between persistent (left slot) and
 * transient (right slot) items. The bottom status bar (#231) reads from
 * this hook; producers subscribe to host events that already exist
 * (install-progress, install-result, uninstall-result) plus the routine
 * schedule from settings, so this hook needs no new IPC channel for the
 * initial surface.
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
  /**
   * Opens Settings → Permissions when the status-bar permission cell is
   * clicked. The permission/review status moved here from the input action
   * row (rendered as plain text after the model name).
   */
  onOpenPermissions?: () => void;
}

/**
 * Hard cap on the toast queue. Prevents an event burst (e.g. 100 install
 * events in one tick) from growing state unbounded between eviction sweeps.
 * The on-screen render only shows the latest 3; capping at 50 leaves
 * generous headroom while bounding memory + re-render cost.
 */
const TOAST_QUEUE_CAP = 50;

/**
 * Left-slot render priority. Lower sorts first. The combined health dot sits
 * just before the provider/model cell (StatusBar joins them visually), and the
 * permission/review status renders immediately after the model name. Items not
 * listed here keep their insertion order *after* these anchored cells (e.g. the
 * transient pre-turn compact indicator).
 */
const PERSISTENT_ORDER: Record<string, number> = {
  "health:services": 0,
  "vendor:llm": 1,
  "permission:mode": 2,
};

function persistentSortKey(id: string): number {
  return PERSISTENT_ORDER[id] ?? 100;
}

export function useStatusBar(opts: UseStatusBarOptions) {
  // LONG_TOAST_TTL_MS (5 s) gives comfortable reading time for a Korean
  // phrase; callers that need a shorter or longer window pass defaultToastTtlMs.
  const { api, defaultToastTtlMs = LONG_TOAST_TTL_MS, onOpenPermissions } = opts;
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
      const ttlMs = input.ttlMs ?? defaultToastTtlMs;
      const expiresAt = Date.now() + ttlMs;
      setToasts((prev) => {
        const newItem: ToastItem = {
          id,
          severity: input.severity,
          message: input.message,
          ttlMs,
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
      setToasts((prev) => {
        if (prev[0]?.id !== visibleToast.id) return prev;
        const [, nextHead, ...rest] = prev;
        if (!nextHead) return [];
        const ttlMs = nextHead.ttlMs ?? defaultToastTtlMs;
        return [{ ...nextHead, expiresAt: Date.now() + ttlMs }, ...rest];
      });
    }, delay);
    return () => clearTimeout(id);
  }, [defaultToastTtlMs, visibleToast]);

  const upsertPersistent = useCallback((item: PersistentItem) => {
    setPersistent((prev) => {
      const idx = prev.findIndex((p) => p.id === item.id);
      if (idx === -1) return [...prev, item];
      // Defense-in-depth against render loops: if a producer re-runs and upserts
      // a structurally identical item (same display fields), return the SAME
      // array so no re-render is triggered. Only `onClick` identity may differ
      // between runs (producers build a fresh closure each time); since the
      // handler is not display state we ignore it here and keep the existing
      // item's reference. This prevents an unstable producer callback from
      // driving an infinite upsert → new-array → re-render loop.
      if (samePersistentDisplay(prev[idx], item)) return prev;
      const next = [...prev];
      next[idx] = item;
      return next;
    });
  }, []);

  const removePersistent = useCallback((id: string) => {
    setPersistent((prev) => prev.filter((p) => p.id !== id));
  }, []);

  // ── Producers (each in its own file under status-bar/)
  // Status bar keeps one compact services health dot plus the active LLM
  // vendor/model and transient toasts. Plugin/tool/MCP counts stay in
  // Settings where their detail panes live.
  useStatusBarNotifications({ api, pushToast });
  useStatusBarInstall({ api, pushToast });
  // Producer registration order determines left-to-right render order in
  // the status bar (StatusBar.tsx maps the persistent array as-is). The
  // combined health dot sits immediately before the provider/model cell so
  // one green indicator means both the LLM provider and marketplace are live.
  useStatusBarHealth({ api, upsertPersistent, removePersistent });
  useStatusBarVendor({ api, upsertPersistent });
  // Registered AFTER vendor so the permission/review status renders to the
  // right of the model name (plain text, divider-separated).
  useStatusBarPermission({ api, upsertPersistent, onOpenPermissions });

  // Stable priority sort so the model/permission cells render in a fixed order
  // regardless of which producer's async fetch resolves first.
  const orderedPersistent = useMemo(() => {
    return persistent
      .map((item, idx) => ({ item, idx }))
      .sort((a, b) => {
        const ka = persistentSortKey(a.item.id);
        const kb = persistentSortKey(b.item.id);
        return ka !== kb ? ka - kb : a.idx - b.idx;
      })
      .map((x) => x.item);
  }, [persistent]);

  return {
    persistent: orderedPersistent,
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
