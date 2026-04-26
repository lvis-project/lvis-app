import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

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
export type StatusBarSeverity = "info" | "success" | "warning" | "error";

export interface PersistentItem {
  id: string;
  severity: StatusBarSeverity;
  /** Short label (left of dot) — e.g. "다음 루틴". */
  label: string;
  /** Variable value (right of dot) — e.g. "04:42 KST". */
  value: string;
}

export interface ToastItem {
  id: string;
  severity: StatusBarSeverity;
  message: string;
  /** Wall-clock ms when this toast should auto-evict. */
  expiresAt: number;
}

interface UseStatusBarOptions {
  api: LvisApi;
  /**
   * Default toast TTL in milliseconds. Override per-toast at push time.
   * 5 s is short enough to feel ephemeral and long enough to read a
   * single Korean sentence.
   */
  defaultToastTtlMs?: number;
}

/**
 * Toast TTL default — picked so a 4-word Korean phrase (~12 chars) can be
 * read at a comfortable pace, but transient enough not to clutter the bar.
 */
const DEFAULT_TOAST_TTL_MS = 5000;

/**
 * Per-toast eviction tick. Status-bar UI is low-frequency so we don't need
 * a tighter loop than 1 Hz — toasts disappear within 1 s of their TTL.
 */
const EVICTION_INTERVAL_MS = 1000;

export function useStatusBar(opts: UseStatusBarOptions) {
  const { api, defaultToastTtlMs = DEFAULT_TOAST_TTL_MS } = opts;
  const [persistent, setPersistent] = useState<PersistentItem[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  // Stable counter for unique toast IDs without leaning on Date.now()
  // (which collides under quick successive pushes).
  const toastCounterRef = useRef(0);

  const pushToast = useCallback(
    (input: { severity: StatusBarSeverity; message: string; ttlMs?: number }) => {
      const id = `toast:${++toastCounterRef.current}`;
      const expiresAt = Date.now() + (input.ttlMs ?? defaultToastTtlMs);
      setToasts((prev) => [...prev, { id, severity: input.severity, message: input.message, expiresAt }]);
      return id;
    },
    [defaultToastTtlMs],
  );

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

  // ── Auto-evict expired toasts on a low-frequency tick.
  useEffect(() => {
    if (toasts.length === 0) return;
    const interval = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => t.expiresAt > now));
    }, EVICTION_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [toasts.length]);

  // ── Producer: plugin install lifecycle.
  useEffect(() => {
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallProgress === "function") {
      unsubs.push(
        api.onPluginInstallProgress(({ slug, phase }) => {
          const message =
            phase === "installing"
              ? `${slug} 설치 중…`
              : `${slug} 재시작 중…`;
          pushToast({ severity: "info", message, ttlMs: 8000 });
        }),
      );
    }
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        api.onPluginInstallResult(({ slug, success, error }) => {
          if (success) pushToast({ severity: "success", message: `${slug} 설치 완료` });
          else pushToast({ severity: "error", message: `${slug} 설치 실패: ${error ?? "unknown"}`, ttlMs: 10000 });
        }),
      );
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(
        api.onPluginUninstallResult(({ slug, success, error }) => {
          if (success) pushToast({ severity: "success", message: `${slug} 제거 완료` });
          else pushToast({ severity: "error", message: `${slug} 제거 실패: ${error ?? "unknown"}`, ttlMs: 10000 });
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [api, pushToast]);

  // ── Producer: next-routine persistent slot.
  // Reads the configured wakeup time from settings on mount and refreshes
  // when the user changes it (settings dialog flushes a re-fetch through
  // the existing `getSettings` round-trip — for Phase 1 we just poll on a
  // mount + window-focus pattern instead of a dedicated push channel).
  useEffect(() => {
    let cancelled = false;
    const refreshNextRoutine = async () => {
      try {
        const s = await api.getSettings();
        if (cancelled) return;
        const t = s.routine?.scheduleTimeKst;
        const enabled = s.routine?.enableWakeupRoutine === true;
        if (enabled && typeof t === "string" && t.length > 0) {
          upsertPersistent({
            id: "routine:next",
            severity: "info",
            label: "다음 루틴",
            value: `${t} KST`,
          });
        } else {
          removePersistent("routine:next");
        }
      } catch {
        // Non-fatal — status bar without the next-routine hint is fine.
      }
    };
    void refreshNextRoutine();
    const onFocus = () => void refreshNextRoutine();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [api, upsertPersistent, removePersistent]);

  // ── Producer: runtime counters (tools / plugins / mcp).
  // Mount fetch + refresh whenever an install/uninstall result lands so the
  // counts reflect the new runtime state without a manual reload.
  useEffect(() => {
    if (typeof api.getRuntimeCounts !== "function") return;
    let cancelled = false;
    const refreshCounts = async () => {
      try {
        const c = await api.getRuntimeCounts();
        if (cancelled) return;
        upsertPersistent({
          id: "runtime:counts",
          severity: "info",
          label: "Runtime",
          value: `Tools ${c.tools} · Plugins ${c.plugins} · MCP ${c.mcps}`,
        });
      } catch {
        // Non-fatal — counts are an awareness signal, not load-bearing.
      }
    };
    void refreshCounts();
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(api.onPluginInstallResult(() => void refreshCounts()));
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(api.onPluginUninstallResult(() => void refreshCounts()));
    }
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api, upsertPersistent]);

  // ── Producer: marketplace reachability dot.
  // Pings every 30 s while the window is focused; pauses when blurred so a
  // long-idle dev session doesn't burn requests against the marketplace.
  // The persistent item is omitted entirely when the user is on the mock
  // backend — no service to ping, nothing to report.
  useEffect(() => {
    if (typeof api.pingMarketplace !== "function") return;
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const refreshMarketplace = async () => {
      try {
        const result = await api.pingMarketplace();
        if (cancelled) return;
        if (!result.configured) {
          removePersistent("marketplace:online");
          return;
        }
        upsertPersistent({
          id: "marketplace:online",
          severity: result.online ? "success" : "error",
          label: "Marketplace",
          value: result.online ? "online" : "offline",
        });
      } catch {
        if (cancelled) return;
        upsertPersistent({
          id: "marketplace:online",
          severity: "error",
          label: "Marketplace",
          value: "offline",
        });
      }
    };
    const start = () => {
      if (intervalId !== null) return;
      void refreshMarketplace();
      intervalId = setInterval(() => void refreshMarketplace(), 30_000);
    };
    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    if (document.hasFocus()) start();
    const onFocus = () => start();
    const onBlur = () => stop();
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      cancelled = true;
      stop();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [api, upsertPersistent, removePersistent]);

  return {
    persistent,
    toasts,
    pushToast,
    upsertPersistent,
    removePersistent,
  };
}
