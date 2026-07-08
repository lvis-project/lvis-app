import { useEffect, useRef } from "react";
import type { LvisApi } from "../types.js";

export interface AppBootstrapDeps {
  api: LvisApi;
  refreshViews: () => Promise<unknown> | unknown;
  refreshCards: () => Promise<void> | void;
  checkApiKey: () => Promise<unknown> | unknown;
  setActiveView: (k: string) => void;
  /** Same inline-settings entry point used by in-app affordances — the main
   *  process routes settings opens through view:activate with a settings tab,
   *  and this reuses onOpenSettings so tab normalization + return-view capture
   *  stay identical to a click. */
  onOpenSettings: (tab?: string) => void;
  toggleCommandPopover: () => void;
}

/**
 * Mount-time bootstrap:
 *  - kick off plugin views/cards and api-key refreshes
 *  - subscribe to plugin view-activate IPC
 *  - register Cmd/Ctrl+K keybinding for the command popover
 *
 * Uses a mounted ref to avoid late async resolutions writing to an unmounted
 * component.
 *
 * Three effects are used:
 *  1. [] — sets isMountedRef lifetime; never re-runs so the ref is never
 *     reset to false mid-life by unrelated dep changes.
 *  2. [] — mount-time side-effects (refreshes + IPC subscription); stable
 *     deps intentionally omitted (eslint-disable comment).
 *  3. [] — attaches the Cmd/Ctrl+K keydown handler once; reads
 *     toggleCommandPopover via toggleRef so it always calls the latest
 *     closure without ever re-attaching the listener.
 */
export function useAppBootstrap({
  api, refreshViews, refreshCards, checkApiKey,
  setActiveView, onOpenSettings, toggleCommandPopover,
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
    void refreshViews();
    void refreshCards();
    void checkApiKey();

    const dv = api.onViewActivate((k, settingsTab) => {
      if (!isMountedRef.current) return;
      // "settings" routes through the SAME inline-settings path as an in-app
      // click so the tab is normalized and the return view is captured
      // identically; there is no detached settings window anymore.
      if (k === "settings") { onOpenSettings(settingsTab); return; }
      setActiveView(k);
    });
    return () => { dv(); };
  }, []);

  // Stable ref so the keydown handler is attached once and never re-attached
  // when toggleCommandPopover identity changes (e.g. due to activeView updates).
  // Synchronous assignment (not useEffect) ensures the ref is always current
  // before any paint — avoids stale ref on the render immediately after updates.
  const toggleRef = useRef(toggleCommandPopover);
  toggleRef.current = toggleCommandPopover;

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
