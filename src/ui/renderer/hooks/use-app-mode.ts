import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import type { getApi } from "../api-client.js";
import type { AppMode } from "../MainToolbar.js";
import { readInitialAppMode } from "../utils/read-initial-app-mode.js";

type Api = ReturnType<typeof getApi>;

export interface UseAppModeResult {
  appMode: AppMode;
  setAppMode: (next: AppMode) => void;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Dispatch<SetStateAction<boolean>>;
  actionPanelOpen: boolean;
  setActionPanelOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Workspace-mode (Chat / Work) state + its coupled shell layout side-effects.
 *
 * Extracted verbatim from App.tsx. Owns:
 *   - `appMode` (SOLE authority for inline-vs-detached), seeded before first
 *     paint from the persisted mode so the shell renders the right layout on
 *     frame 0. `setAppMode` persists to host settings, guarded against no-op
 *     writes (#1312 render-loop guard).
 *   - `sidebarCollapsed` (owned by the shell; per-transition default coupled to
 *     appMode, NOT a lock) + `actionPanelOpen` (work-mode Tool Activity panel).
 *   - the three appMode-transition effects: rail-width coupling, OS-window
 *     resizeForMode (mount-skip via ref), and closeAllDetached on → work.
 *
 * The IPC bridges (`api.window?.resizeForMode` / `closeAllDetached`) are
 * optional (absent in jsdom / non-Electron) and guarded accordingly.
 */
export function useAppMode(api: Api): UseAppModeResult {
  // Seed from the persisted workspace mode injected by the main process
  // (preload's `window.__lvisInitialAppMode`). Reading it at initializer time
  // — before first paint — makes the shell render the saved mode's layout on
  // frame 0 (expanded rail for work, collapsed for chat) with no wrong-mode
  // flash followed by a post-mount tween. Defaults to "work" on first run /
  // non-Electron harness.
  const [appMode, setAppModeState] = useState<AppMode>(readInitialAppMode);
  // Sidebar collapse is owned by the shell (the floating-card Sidebar reads it
  // as a prop and never manages its own state). Seeded from the same persisted
  // mode so the rail starts at the correct width on frame 0 (no post-mount
  // width tween). The rail width is coupled to appMode on each transition (see
  // the effect below): work expands it, chat collapses it — a per-transition
  // default, NOT a lock.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readInitialAppMode() === "chat");
  // The 도구 활동 (Tool Activity) panel defaults to its collapsed rail: on a
  // fresh launch the full expanded card should not auto-show — the user opens it
  // on demand. (Only rendered in work mode; see the appMode gate at its mount.)
  const [actionPanelOpen, setActionPanelOpen] = useState(false);
  // Persist appMode to host settings and update local state. Guarded against
  // no-op writes (same mode) so a re-render or repeated toggle never fires a
  // redundant IPC write. Stable identity (useCallback with only `api`) so it is
  // safe in effect deps — no unstable-callback render loop (#1312 guard).
  const setAppMode = useCallback((next: AppMode) => {
    setAppModeState((prev) => {
      if (prev === next) return prev;
      // Persist the new mode so the next boot seeds from it. Fire-and-forget:
      // a failed write only means the next launch falls back to the previous
      // saved value — never blocks the toggle or surfaces an error toast.
      void api.updateSettings({ system: { appMode: next } });
      return next;
    });
  }, [api]);
  // appMode drives the rail's default width on each mode transition: work
  // mode expands it (wide working layout — inline views need the room), chat
  // mode collapses it to the focused icon rail (views detach to windows). This
  // makes toggling visibly widen/narrow the shell. It is a per-transition
  // default, NOT a lock — the user may still collapse/expand manually within a
  // mode without it snapping back until the next mode switch. On the initial
  // mount this re-asserts the already-seeded value (a no-op render), so it
  // costs nothing and keeps the transition semantics in one place.
  useEffect(() => {
    setSidebarCollapsed(appMode === "chat");
  }, [appMode]);
  // Resize the OS window to match the mode on mode CHANGES only. The window is
  // already created at the persisted mode's bounds (main.ts initialMainWindowBounds),
  // so firing resizeForMode on the initial mount would issue a same-target tween
  // — a needless animation on boot. The first-run ref skips that mount call;
  // subsequent toggles resize as before. The bridge is optional (absent in
  // jsdom / non-Electron); guard accordingly.
  const resizeForModeMountedRef = useRef(false);
  useEffect(() => {
    if (!resizeForModeMountedRef.current) {
      resizeForModeMountedRef.current = true;
      return;
    }
    void api.window?.resizeForMode?.(appMode);
  }, [appMode, api]);
  // Work mode is the inline workspace: every view renders in the main tab,
  // so any windows that were detached in chat mode must close on the
  // transition. The login/auth window is ALWAYS a separate window
  // regardless of mode and is excluded by the main process (auth windows are
  // never tracked as detached tabs). Fire-on-transition only: this depends
  // solely on stable refs (appMode + the stable api) and never sets state, so
  // it cannot re-trigger itself (#1312 render-loop guard).
  useEffect(() => {
    if (appMode !== "work") return;
    void api.window?.closeAllDetached?.();
  }, [appMode, api]);

  return {
    appMode,
    setAppMode,
    sidebarCollapsed,
    setSidebarCollapsed,
    actionPanelOpen,
    setActionPanelOpen,
  };
}
