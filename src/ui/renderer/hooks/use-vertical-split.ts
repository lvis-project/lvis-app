import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import {
  SIDE_PANEL_SPLIT_DEFAULT_PERCENT,
  clampSidePanelSplitPercent,
} from "../../../shared/side-panel.js";

/**
 * The `SystemSettings` fields that persist a workspace-rail vertical split. One
 * per tab kind whose body is a list-over-viewer layout; browser is excluded
 * (its list moved to a floating search Popover, so it has no vertical split).
 */
export type VerticalSplitStorageKey =
  | "sidePanelSplitFilePercent"
  | "sidePanelSplitPreviewPercent"
  | "sidePanelSplitSubagentPercent";

export interface UseVerticalSplitResult {
  /** Current TOP-pane percent (drag-live), clamped to the pane range. */
  topPercent: number;
  /** Update the percent during a drag / keyboard step — state only, no IPC. */
  setTopPercent: (percent: number) => void;
  /** Persist the percent to host settings (drag-end / keyboard step), guarded. */
  commitTopPercent: (percent: number) => void;
}

/**
 * Owns one workspace-rail vertical (list↕viewer) split ratio, persisted to
 * `SystemSettings.<storageKey>`. Deliberately a round-trip clone of
 * `useSidePanelWidth` (mount seed + drag-end persist) — durability comes from
 * the settings round-trip, NOT the mount location, so the ratio survives the
 * ChatSidePanel conditional unmount just like the docked width. It is NOT an
 * extension of the width hook: the two persist independent fields and must not
 * share a cleanup ref (a horizontal-width drag and a vertical-split drag can be
 * in flight against different DOM handles).
 *
 * Drag emits per-move `setTopPercent` (state only); release / keyboard emits
 * `commitTopPercent` (one IPC write, no-op guarded). The value is stored as the
 * TOP pane's share of the tab-body height; both sides are clamped to the shared
 * [MIN, MAX] pane range so neither pane can collapse to zero.
 */
export function useVerticalSplit(
  api: LvisApi,
  storageKey: VerticalSplitStorageKey,
): UseVerticalSplitResult {
  const [topPercent, setTopPercentState] = useState<number>(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);
  const persistedRef = useRef<number>(SIDE_PANEL_SPLIT_DEFAULT_PERCENT);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const raw = settings?.system?.[storageKey];
        if (typeof raw === "number" && Number.isFinite(raw)) {
          const clamped = clampSidePanelSplitPercent(raw);
          persistedRef.current = clamped;
          setTopPercentState(clamped);
        }
      })
      .catch(() => {
        // Non-fatal: keep the default; the next commit persists.
      });
    return () => {
      cancelled = true;
    };
  }, [api, storageKey]);

  const setTopPercent = useCallback((percent: number) => {
    setTopPercentState(clampSidePanelSplitPercent(percent));
  }, []);

  const commitTopPercent = useCallback(
    (percent: number) => {
      const clamped = clampSidePanelSplitPercent(percent);
      if (clamped === persistedRef.current) return;
      persistedRef.current = clamped;
      void api.updateSettings({ system: { [storageKey]: clamped } });
    },
    [api, storageKey],
  );

  return { topPercent, setTopPercent, commitTopPercent };
}
