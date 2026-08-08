import { useCallback, useEffect, useRef, useState } from "react";
import { sameViewLocation, type ViewLocation } from "../utils/view-location.js";

/**
 * Visit history for the main window — back and forward, browser-style.
 *
 * The app had no history of any kind. The closest thing was a single-slot ref
 * that remembered the view Settings was entered from; every other "back" went
 * unconditionally home. Owner decision: back means "where I was", not "one
 * level up".
 *
 * History is recorded by OBSERVING the location rather than by asking each
 * navigation site to push. There are several producers — sidebar selection,
 * the command palette, notification clicks, the activate-view IPC, the
 * settings panel's own tab moves — and a push call at each is a rule every
 * future producer has to remember. Watching the location instead means a new
 * producer is recorded by construction.
 */

/** Beyond this, the oldest entries are dropped. Entries are two short strings,
 *  so the cap exists to stop unbounded growth, not to save memory. */
export const VIEW_HISTORY_LIMIT = 50;

/** Entries oldest-first; `index` is the current one. Held as ONE value so a
 *  single pure updater moves both — they must never disagree. */
interface HistoryState {
  entries: ViewLocation[];
  index: number;
}

export interface UseViewHistoryResult {
  canGoBack: boolean;
  canGoForward: boolean;
  /** Where each control would land, so a caller can NAME the destination.
   *  Matters most in chat mode, where the path itself does not render. */
  backTo: ViewLocation | null;
  forwardTo: ViewLocation | null;
  goBack: () => void;
  goForward: () => void;
  /** Entry count including the current location — for tests and diagnostics. */
  depth: number;
}

export function useViewHistory(
  location: ViewLocation,
  navigate: (to: ViewLocation) => void,
  /**
   * True while the app is still settling into its restored launch location
   * (#1995 applies it asynchronously). Such a change is not a visit: the user
   * did not travel from `home`, they arrived where they left off. Recording it
   * would leave a restart offering "back" to a screen nobody opened, and both
   * features' own tests would still pass — only the pair would be wrong.
   */
  restoring = false,
): UseViewHistoryResult {
  const [state, setState] = useState<HistoryState>(() => ({ entries: [location], index: 0 }));
  // Set while a back/forward is being applied, so the resulting location change
  // is recognized as a replay rather than recorded as a new visit.
  const replayingRef = useRef(false);
  // Flips once the launch location is established; see the effect below.
  const settledRef = useRef(false);

  useEffect(() => {
    if (replayingRef.current) {
      replayingRef.current = false;
      return;
    }
    // Until the app has settled on its launch location, every change REPLACES
    // the root rather than stacking on it. A boolean window alone is not
    // enough: #1995 applies the restored view and finishes hydrating in the
    // same React batch, so by the time this effect runs `restoring` is already
    // false and the arrival looks exactly like a step away from `home`. The
    // rule is therefore "the first location seen once restoring is over IS the
    // root", which holds whichever order those two land in.
    const settling = !settledRef.current;
    if (settling && !restoring) settledRef.current = true;

    setState((current) => {
      const here = current.entries[current.index];
      // Re-selecting where you already are is not a visit. Sidebar entries get
      // clicked again all the time, and recording those fills the history with
      // steps that appear to do nothing when replayed.
      if (here && sameViewLocation(here, location)) return current;

      if (settling) {
        const entries = current.entries.slice();
        entries[current.index] = location;
        return { entries, index: current.index };
      }

      // A new visit truncates anything ahead, exactly as a browser does.
      const kept = current.entries.slice(0, current.index + 1);
      kept.push(location);
      const overflow = Math.max(0, kept.length - VIEW_HISTORY_LIMIT);
      const entries = overflow > 0 ? kept.slice(overflow) : kept;
      return { entries, index: entries.length - 1 };
    });
  }, [location.view, location.settingsTab, restoring]);

  // Read through a ref so `step` can stay a stable callback while still seeing
  // the freshest entries — and so `navigate` is called OUTSIDE the state
  // updater, which must stay pure (React may invoke updaters more than once).
  const stateRef = useRef(state);
  stateRef.current = state;

  const step = useCallback((delta: number) => {
    const current = stateRef.current;
    const next = current.index + delta;
    const target = current.entries[next];
    if (!target) return;
    // Set before `navigate` so the location change it causes is already
    // recognizable as a replay by the time the effect above runs.
    replayingRef.current = true;
    setState({ ...current, index: next });
    navigate(target);
  }, [navigate]);

  const goBack = useCallback(() => step(-1), [step]);
  const goForward = useCallback(() => step(1), [step]);

  return {
    canGoBack: state.index > 0,
    canGoForward: state.index < state.entries.length - 1,
    backTo: state.entries[state.index - 1] ?? null,
    forwardTo: state.entries[state.index + 1] ?? null,
    goBack,
    goForward,
    depth: state.entries.length,
  };
}
