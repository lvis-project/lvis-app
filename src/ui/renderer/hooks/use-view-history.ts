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
 *
 * The launch RESTORE is the one thing that reports itself, and it is the
 * exception that proves the rule: it is not a navigation producer, there is
 * one of it per half of the location, and it is the only mover the location
 * alone cannot identify. Nothing is asked of the navigation producers, so the
 * property above still holds for every one of them.
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
   * Count of location changes the RESTORE made, from the hooks that own the
   * stored launch location. Monotonic; an increase since the previous
   * observation is what marks a change as the restore's own move.
   *
   * Observation cannot tell a restored arrival from a deliberate step by
   * looking at the location alone, and a window of TIME cannot separate them
   * either — a sidebar click lands inside that window on any slow launch, and
   * treating it as the arrival left the user on a screen with a dead back
   * button. Counting the restore's moves is the one thing no navigation can
   * imitate. This is not a per-navigation push: the producers are few, fixed,
   * and are not navigation sites at all, so nothing is asked of the many
   * navigation producers this hook exists to observe.
   */
  restoresApplied = 0,
): UseViewHistoryResult {
  const [state, setState] = useState<HistoryState>(() => ({ entries: [location], index: 0 }));
  // Set while a back/forward is being applied, so the resulting location change
  // is recognized as a replay rather than recorded as a new visit.
  const replayingRef = useRef(false);
  // The count as of the previous observation, so an increase can be attributed
  // to exactly one location change and never carried into a later one.
  const seenRestoresRef = useRef(restoresApplied);

  useEffect(() => {
    // Consumed before the replay guard: a signal that is not attributed here
    // must not survive to be misread as belonging to the next change.
    const restored = seenRestoresRef.current !== restoresApplied;
    seenRestoresRef.current = restoresApplied;

    if (replayingRef.current) {
      replayingRef.current = false;
      return;
    }

    setState((current) => {
      const here = current.entries[current.index];
      // Re-selecting where you already are is not a visit. Sidebar entries get
      // clicked again all the time, and recording those fills the history with
      // steps that appear to do nothing when replayed.
      if (here && sameViewLocation(here, location)) return current;

      // The restore REPLACES the root — the user did not travel from `home`,
      // they arrived where they left off, and a restart must not offer "back"
      // to a screen nobody opened. Only while the history is still the untouched
      // seed, though: once the user has been somewhere, a restore that moves
      // them off it is a move they must be able to undo, so it stacks like any
      // other.
      if (restored && current.entries.length === 1) return { entries: [location], index: 0 };

      // A new visit truncates anything ahead, exactly as a browser does.
      const kept = current.entries.slice(0, current.index + 1);
      kept.push(location);
      const overflow = Math.max(0, kept.length - VIEW_HISTORY_LIMIT);
      const entries = overflow > 0 ? kept.slice(overflow) : kept;
      return { entries, index: entries.length - 1 };
    });
  }, [location.view, location.settingsTab, restoresApplied]);

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
