import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { SIDEBAR_DEFAULT_WIDTH, clampSidebarWidth } from "../../../shared/side-panel.js";

export interface UseSidebarWidthResult {
  /** Current expanded sidebar width in px (drag-live). */
  sidebarWidth: number;
  /** Update width during a drag — state only, no IPC (per-move). */
  setSidebarWidth: (px: number) => void;
  /** Persist width to host settings (drag-end / keyboard step / reset), no-op guarded. */
  commitSidebarWidth: (px: number) => void;
  /** Reset to the default width and persist (double-click on the handle). */
  resetSidebarWidth: () => void;
}

/**
 * Owns the primary (left) navigation sidebar's expanded width. Mirrors
 * `useSidePanelWidth`: the width is a durable shell-layout preference persisted
 * via `SystemSettings.sidebarWidth` (mount seed via `getSettings()`, drag-end
 * persist via `updateSettings()`). Per-move `setSidebarWidth` updates state
 * only; release / keyboard / reset call `commitSidebarWidth` (one guarded IPC
 * write). Values are clamped to [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] by the
 * shared `clampSidebarWidth`, matching the settings-store validation floor/ceil.
 */
export function useSidebarWidth(api: LvisApi): UseSidebarWidthResult {
  const [sidebarWidth, setSidebarWidthState] = useState<number>(SIDEBAR_DEFAULT_WIDTH);
  const persistedRef = useRef<number>(SIDEBAR_DEFAULT_WIDTH);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const width = settings?.system?.sidebarWidth;
        if (typeof width === "number" && Number.isFinite(width)) {
          const clamped = clampSidebarWidth(width);
          persistedRef.current = clamped;
          setSidebarWidthState(clamped);
        }
      })
      .catch(() => {
        // Non-fatal: fall back to the default width. The next commit persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setSidebarWidth = useCallback((px: number) => {
    setSidebarWidthState(clampSidebarWidth(px));
  }, []);

  const commitSidebarWidth = useCallback(
    (px: number) => {
      const clamped = clampSidebarWidth(px);
      setSidebarWidthState(clamped);
      if (clamped === persistedRef.current) return;
      persistedRef.current = clamped;
      void api.updateSettings({ system: { sidebarWidth: clamped } });
    },
    [api],
  );

  const resetSidebarWidth = useCallback(() => {
    commitSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }, [commitSidebarWidth]);

  return { sidebarWidth, setSidebarWidth, commitSidebarWidth, resetSidebarWidth };
}
