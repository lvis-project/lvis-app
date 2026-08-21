import { useCallback, useEffect, useRef, useState } from "react";
import type { AppSettings, DeepPartial, LvisApi } from "../types.js";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDE_PANEL_DEFAULT_WIDTH,
  clampSidebarWidth,
} from "../../../shared/side-panel.js";

/** The `SystemSettings` numeric keys that hold a durable panel width (px). */
type PanelWidthSettingsKey = "sidebarWidth" | "sidePanelWidth";

type SystemPatch = NonNullable<DeepPartial<AppSettings>["system"]>;

/**
 * Per-panel configuration for {@link usePanelWidth}. One value per axis on
 * which the two edge-resizable shell panels (left navigation Sidebar, right
 * docked ChatSidePanel) actually differ; everything else is one code path.
 */
export interface PanelWidthPref {
  /** `SystemSettings` key this width is seeded from and persisted to. */
  readonly settingsKey: PanelWidthSettingsKey;
  /** Width used before the settings seed lands, and when it is absent/invalid. */
  readonly defaultWidth: number;
  /**
   * Applied to every value entering state or persistence. The sidebar has a
   * fixed [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] box, so it clamps here; the
   * side panel's ceiling is viewport-relative and is enforced by
   * `useEdgeResize`'s live `max` instead, so it passes values through.
   */
  readonly clamp: (px: number) => number;
  /**
   * Whether `commitWidth` also pushes the value into state. The sidebar's
   * commit is self-sufficient (keyboard steps and double-click reset call only
   * commit); the side panel's owner re-emits `setWidth` alongside every commit,
   * so its commit is persist-only.
   */
  readonly commitUpdatesState: boolean;
}

/** Pass-through clamp for a panel whose bounds are enforced by the resize primitive. */
function passThroughWidth(px: number): number {
  return px;
}

/**
 * Primary (left) navigation sidebar. Width is clamped to the fixed
 * [SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH] box by the shared `clampSidebarWidth`,
 * matching the settings-store validation floor/ceiling.
 */
export const SIDEBAR_WIDTH_PREF: PanelWidthPref = {
  settingsKey: "sidebarWidth",
  defaultWidth: SIDEBAR_DEFAULT_WIDTH,
  clamp: clampSidebarWidth,
  commitUpdatesState: true,
};

/**
 * Right-docked ChatSidePanel. Bounds live in the `EdgeResizeBar` wiring
 * (`min={SIDE_PANEL_MIN_WIDTH}`, `max` = live `100vw - 12rem`) rather than
 * here, so this pref clamps nothing and its commit is persist-only.
 */
export const SIDE_PANEL_WIDTH_PREF: PanelWidthPref = {
  settingsKey: "sidePanelWidth",
  defaultWidth: SIDE_PANEL_DEFAULT_WIDTH,
  clamp: passThroughWidth,
  commitUpdatesState: false,
};

export interface UsePanelWidthResult {
  /** Current panel width in px (drag-live). */
  width: number;
  /** Update width during a drag — state only, no IPC (per-move). */
  setWidth: (px: number) => void;
  /** Persist width to host settings (drag-end / keyboard step / double-click
   *  reset — the shared EdgeResizeBar commits its reset width through this
   *  same setter), no-op guarded. */
  commitWidth: (px: number) => void;
}

/**
 * Owns the durable width of an edge-resizable shell panel. Both the left
 * navigation Sidebar and the right-docked ChatSidePanel drive the SAME
 * `EdgeResizeBar`/`useEdgeResize` primitive, so they run through this one hook
 * and differ only by the {@link PanelWidthPref} they pass.
 *
 * The width is a durable shell-layout preference (same family as appMode /
 * closeBehavior) persisted under `SystemSettings`: mount seed via
 * `getSettings()`, drag-end persist via `updateSettings()`. Durability comes
 * from that settings round-trip, not the mount location, so the width survives
 * ChatSidePanel's conditional unmount.
 *
 * Drag emits per-move `setWidth` (state only); release / keyboard / reset emits
 * `commitWidth` (at most one IPC write, guarded against a no-op like
 * `setAppMode`). No preload prime: the side panel boots closed, so there is no
 * frame-0 width flash — the async `getSettings()` seed lands before the user
 * can open the rail.
 */
export function usePanelWidth(api: LvisApi, pref: PanelWidthPref): UsePanelWidthResult {
  const [width, setWidthState] = useState<number>(pref.defaultWidth);
  const persistedRef = useRef<number>(pref.defaultWidth);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const seeded = settings?.system?.[pref.settingsKey];
        if (typeof seeded === "number" && Number.isFinite(seeded)) {
          const clamped = pref.clamp(seeded);
          persistedRef.current = clamped;
          setWidthState(clamped);
        }
      })
      .catch(() => {
        // Non-fatal: fall back to the default width. The next commit persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api, pref]);

  const setWidth = useCallback(
    (px: number) => {
      setWidthState(pref.clamp(px));
    },
    [pref],
  );

  const commitWidth = useCallback(
    (px: number) => {
      const clamped = pref.clamp(px);
      if (pref.commitUpdatesState) setWidthState(clamped);
      if (clamped === persistedRef.current) return;
      persistedRef.current = clamped;
      const patch: SystemPatch = {};
      patch[pref.settingsKey] = clamped;
      void api.updateSettings({ system: patch });
    },
    [api, pref],
  );

  return { width, setWidth, commitWidth };
}
