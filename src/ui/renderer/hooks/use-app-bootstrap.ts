import { useEffect, useRef } from "react";
import type { LvisApi } from "../types.js";

export interface AppBootstrapDeps {
  api: LvisApi;
  refreshMarketplace: () => Promise<void> | void;
  refreshViews: () => Promise<unknown> | unknown;
  refreshCards: () => Promise<void> | void;
  checkApiKey: () => Promise<unknown> | unknown;
  setActiveView: (k: string) => void;
  toggleCommandPopover: () => void;
}

/**
 * Mount-time bootstrap:
 *  - kick off marketplace / views / api-key refreshes
 *  - subscribe to plugin view-activate IPC
 *  - register Cmd/Ctrl+K keybinding for the command popover
 *
 * Uses a mounted ref to avoid late async resolutions writing to an unmounted
 * component (PR#44 HIGH).
 *
 * isMountedRef cleanup is in a separate [] effect so that re-runs caused by
 * toggleCommandPopover identity changes do not reset the ref to false before
 * the new effect body executes — which would permanently dead the IPC guard.
 */
export function useAppBootstrap({
  api, refreshMarketplace, refreshViews, refreshCards, checkApiKey,
  setActiveView, toggleCommandPopover,
}: AppBootstrapDeps) {
  const isMountedRef = useRef(true);

  // Track component lifetime only — never re-runs, never resets ref mid-life.
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  // Mount-time side-effects + view-activate subscription.
  // api and the refresh fns are stable references — eslint-disable covers the
  // intentional omission of non-reactive stable deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    void refreshMarketplace();
    void refreshViews();
    void refreshCards();
    void checkApiKey();

    const dv = api.onViewActivate((k) => { if (isMountedRef.current) setActiveView(k); });
    return () => { dv(); };
  }, []);

  // Stable ref so the keydown handler is attached once and never re-attached
  // when toggleCommandPopover identity changes (e.g. due to activeView updates).
  const toggleRef = useRef(toggleCommandPopover);
  useEffect(() => { toggleRef.current = toggleCommandPopover; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); };
  }, []);
}
