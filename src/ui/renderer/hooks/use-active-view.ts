import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { parseInlineViewKey, type InlineViewKey } from "../../../shared/view-key.js";

export interface UseActiveViewResult {
  /** Where the main window is. */
  activeView: InlineViewKey;
  /** Navigate — persists immediately (same durable-preference family as `sidebarActiveTab`). */
  setActiveView: (next: InlineViewKey | ((current: InlineViewKey) => InlineViewKey)) => void;
  /**
   * How many times THIS hook has applied the stored location. Monotonic; the
   * count itself means nothing, an increase is the whole signal.
   *
   * Restoring MOVES `activeView` without the user going anywhere, so anything
   * that records where the user has been must be able to tell the two apart —
   * and a window of time cannot, because a click and the restore can fall
   * inside the same window. This counts the restore's own moves instead, which
   * no user navigation can be mistaken for. Visit history reads a location
   * change that arrives with an increase as the launch location taking its
   * place as the root; without it a restart would leave a back button pointing
   * at a home screen nobody visited.
   */
  restoresApplied: number;
}

/**
 * The main window's location, persisted so a restart resumes it.
 *
 * Mirrors `useSidebarTab`: mount-seed from `SystemSettings`, then a single
 * setter that updates local state and writes through, guarded so the seed is
 * not written straight back before the initial read resolves. A navigation is
 * discrete and has no uncommitted intermediate state (unlike a width drag), so
 * every switch persists rather than debouncing.
 *
 * Restoring a PLUGIN view has to WAIT rather than navigate.
 * `parseInlineViewKey` answers "is this a key the main window can be at?", and
 * `plugin:<id>:<viewId>` stays perfectly well-formed after its plugin is
 * uninstalled, so structure alone cannot decide. Navigating anyway and letting
 * the existing uninstalled-plugin fallback in `usePluginViewRouting` clean up
 * would be worse than it looks: that fallback fires whenever the view is
 * missing, INCLUDING the moment before the plugin list has loaded, and it goes
 * through `setActiveView` — so a cold boot would bounce a perfectly valid
 * restore home and PERSIST "home" over the user's stored location, losing it for
 * good. Holding the key until the loaded list contains it is what keeps a
 * transiently-unavailable plugin from erasing where the user was.
 *
 * Built-ins carry no such doubt and are applied straight away, so the common
 * case has no delay.
 *
 * The pending restore is dropped the moment the user navigates: a late-arriving
 * plugin list must never yank someone off a view they chose themselves.
 */
export function useActiveView(
  api: LvisApi,
  /** View keys the app has actually loaded — `toViewKey` over `pluginViews`. */
  loadedPluginViewKeys: readonly string[],
): UseActiveViewResult {
  const [activeView, setActiveViewState] = useState<InlineViewKey>("home");
  // A ref, not state, so `setActiveView` keeps ONE identity for the life of the
  // app. It stands in for a `useState` setter at call sites whose dep arrays
  // rightly omit it; an identity that changed once hydration finished would
  // leave those closures holding a setter that no longer persists.
  const hydratedRef = useRef(false);
  // STATE: a consumer has to re-render to observe the restore's move, and it
  // has to land in the SAME commit as the move itself or the two would be
  // observed as separate changes.
  const [restoresApplied, setRestoresApplied] = useState(0);
  // STATE, not a ref: the "has it loaded yet?" effect must re-run when EITHER
  // the pending key or the loaded list changes. Holding this in a ref made the
  // restore depend on the list changing AFTER the settings read resolved — with
  // the opposite ordering the effect had already run and nothing re-triggered
  // it, so a perfectly valid restore was silently dropped.
  const [pendingPluginView, setPendingPluginView] = useState<InlineViewKey | null>(null);
  // Mirrors `activeView` so the setter can resolve an updater and decide
  // whether to write WITHOUT doing either inside a state-updater callback,
  // which React is free to invoke more than once.
  const activeViewRef = useRef<InlineViewKey>("home");
  const applyView = useCallback((next: InlineViewKey) => {
    activeViewRef.current = next;
    setActiveViewState(next);
  }, []);
  // The ONE way a restore moves the window. Both restore paths go through it,
  // so the count cannot drift from the moves it describes — and a future
  // restore path declares itself by construction rather than by remembering.
  const restoreView = useCallback((next: InlineViewKey) => {
    setRestoresApplied((applied) => applied + 1);
    applyView(next);
  }, [applyView]);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const stored = settings?.system?.activeView;
        if (typeof stored !== "string") return;
        const parsed = parseInlineViewKey(stored);
        // Unparseable, or a key with no inline form: stay home, silently.
        if (!parsed) return;
        if (parsed.kind === "plugin") {
          setPendingPluginView(parsed.key);
          return;
        }
        restoreView(parsed.key);
      })
      .catch(() => {
        // Non-fatal: home is a valid place to be. The next navigation persists.
      })
      .finally(() => {
        if (cancelled) return;
        hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [api, restoreView]);

  useEffect(() => {
    if (!pendingPluginView) return;
    // Not there (yet). Stay home and wait: if the list never gains this key —
    // the plugin was uninstalled — home is where the app stays.
    if (!loadedPluginViewKeys.includes(pendingPluginView)) return;
    setPendingPluginView(null);
    restoreView(pendingPluginView);
  }, [restoreView, loadedPluginViewKeys, pendingPluginView]);

  const setActiveView = useCallback(
    (next: InlineViewKey | ((current: InlineViewKey) => InlineViewKey)) => {
      // A deliberate navigation retires any restore still waiting on plugins.
      setPendingPluginView(null);
      const current = activeViewRef.current;
      const resolved = typeof next === "function" ? next(current) : next;
      applyView(resolved);
      // Guard against persisting the seed value back before the initial read
      // resolves, and against a redundant write for a no-op navigation.
      if (hydratedRef.current && resolved !== current) {
        void api.updateSettings({ system: { activeView: resolved } });
      }
    },
    [api, applyView],
  );

  return { activeView, setActiveView, restoresApplied };
}
