import { useEffect, useRef } from "react";
import type { LvisApi } from "../types.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export interface AppBootstrapDeps {
  api: LvisApi;
  refreshMarketplace: () => Promise<void> | void;
  refreshViews: () => Promise<unknown> | unknown;
  checkApiKey: () => Promise<unknown> | unknown;
  seedBriefing: (entries: ChatEntry[]) => void;
  setActiveView: (k: string) => void;
  openCommandPalette: () => void;
}

/**
 * Mount-time bootstrap:
 *  - kick off marketplace / views / api-key refreshes
 *  - seed chat with the daily briefing (if any)
 *  - subscribe to plugin view-activate IPC
 *  - register Cmd/Ctrl+K keybinding for the command palette
 *
 * Uses a mounted ref to avoid late async resolutions writing to an unmounted
 * component (PR#44 HIGH).
 */
export function useAppBootstrap({
  api, refreshMarketplace, refreshViews, checkApiKey,
  seedBriefing, setActiveView, openCommandPalette,
}: AppBootstrapDeps) {
  const isMountedRef = useRef(true);
  useEffect(() => {
    void refreshMarketplace();
    void refreshViews();
    void checkApiKey();

    api.getBriefing().then((text) => {
      if (text && isMountedRef.current) seedBriefing([{ kind: "assistant", text }]);
    }).catch(() => {});

    const dv = api.onViewActivate((k) => { if (isMountedRef.current) setActiveView(k); });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCommandPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      isMountedRef.current = false;
      dv();
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
