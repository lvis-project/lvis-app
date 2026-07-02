import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { SIDE_PANEL_DEFAULT_WIDTH } from "../../../shared/side-panel.js";

export interface UseSidePanelWidthResult {
  /** Current docked panel width in px (drag-live). */
  sidePanelWidth: number;
  /** Update width during a drag — state only, no IPC (per-move). */
  setSidePanelWidth: (px: number) => void;
  /** Persist width to host settings (drag-end / keyboard step), no-op guarded. */
  commitSidePanelWidth: (px: number) => void;
}

/**
 * Owns the ChatSidePanel docked width. The width is a durable shell-layout
 * preference (same family as appMode / closeBehavior) so it persists across
 * restarts via `SystemSettings.sidePanelWidth`. Mounted at ChatView level next
 * to the workspace-tab store: durability comes from the settings round-trip
 * (mount seed + drag-end persist), not the mount location, so the width
 * survives ChatSidePanel's conditional unmount.
 *
 * Drag emits per-move `setSidePanelWidth` (state only); release/keyboard emits
 * `commitSidePanelWidth` (one IPC write, guarded against no-op like
 * `setAppMode`). No preload prime: the panel boots closed, so there is no
 * frame-0 width flash — the async `getSettings()` seed lands before the user
 * can open the rail.
 */
export function useSidePanelWidth(api: LvisApi): UseSidePanelWidthResult {
  const [sidePanelWidth, setSidePanelWidthState] = useState<number>(SIDE_PANEL_DEFAULT_WIDTH);
  const persistedRef = useRef<number>(SIDE_PANEL_DEFAULT_WIDTH);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const width = settings?.system?.sidePanelWidth;
        if (typeof width === "number" && Number.isFinite(width)) {
          persistedRef.current = width;
          setSidePanelWidthState(width);
        }
      })
      .catch(() => {
        // Non-fatal: fall back to the default width. The next commit persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setSidePanelWidth = useCallback((px: number) => {
    setSidePanelWidthState(px);
  }, []);

  const commitSidePanelWidth = useCallback(
    (px: number) => {
      if (px === persistedRef.current) return;
      persistedRef.current = px;
      void api.updateSettings({ system: { sidePanelWidth: px } });
    },
    [api],
  );

  return { sidePanelWidth, setSidePanelWidth, commitSidePanelWidth };
}
