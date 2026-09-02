import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { parseInlineViewKey, type InlineViewKey } from "../../../shared/view-key.js";

/**
 * Where the window's location actually LIVES: the focused pane's content.
 *
 * `activeView` used to be this hook's own `useState`. It is DERIVED now — the
 * hook owns the restore and the persistence of the location, the pane model
 * owns the value. One place a location can be, rather than two that have to be
 * kept equal. With one focused pane the two readings are identical, which is
 * why nothing above this hook changes shape.
 */
export interface ActiveViewPane {
  /** The focused pane's view. `activeView` IS this. */
  view: InlineViewKey;
  /** Show `next` in the focused pane. */
  navigate: (next: InlineViewKey) => void;
}

export interface UseActiveViewResult {
  /** Where the main window is — the focused pane's view. */
  activeView: InlineViewKey;
  /**
   * Navigate — persists immediately, INCLUDING before the initial read has
   * resolved. That last part is a deliberate divergence from `useSidebarTab`
   * and `useSettingsTab`, which suppress writes until their own read lands:
   * those two let the read win the race and overwrite local state with the
   * stored value, so a write made before it arrives has nothing to protect.
   * This hook lets the NAVIGATION win it instead, so the same suppression
   * would leave the location it just discarded as the one the next launch
   * restores.
   */
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
 * setter that updates local state and writes through. A navigation is discrete
 * and has no uncommitted intermediate state (unlike a width drag), so every
 * switch persists rather than debouncing.
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
 * A NAVIGATION ENDS THE RESTORE, whichever part of it is still outstanding.
 * The stored location is authoritative only until the user chooses one; from
 * the first navigation on it is stale, and applying it — now, if the settings
 * read is still in flight, or later, when a slow plugin list finally admits a
 * key that was held back — moves the user off a screen they picked themselves.
 * Both windows have to be covered, because neither guard reaches the other's:
 * clearing the held key cannot stop one that has not been read yet, and
 * refusing a late read cannot retract one already waiting.
 *
 * The same moment is what makes that navigation writable. Discarding the
 * stored location without replacing it would leave the user where they chose
 * for this run and back on the stale location at the next launch — the same
 * lost place by a slower route — so the first navigation is what the next
 * launch restores, exactly as every later one is, no-op or not.
 *
 * One navigation INTENT does not reach this hook at all: selecting an unauthed
 * plugin's view runs its login tool and defers the open, so nothing here
 * learns that the user has chosen a destination and the stored location can
 * still move the window while the sign-in is up. The deferred open lands where
 * they asked once auth completes, so they end in the right place, but the
 * screen moves under them on the way. Closing that needs the choice to be
 * declared at the point it is made, in `usePluginViewRouting`.
 *
 * The OTHER half of the location — the settings PAGE, restored by its own read
 * in `useSettingsTab` — is deliberately outside this rule, and still lands
 * after a navigation here. Choosing a view says nothing about which settings
 * page you want, so dropping the page restore because someone clicked Home
 * would discard a preference they never expressed. Note that half currently
 * lands unconditionally: `useSettingsTab` has no discard of its own, so
 * choosing a settings PAGE inside the restore window is still overridden. That
 * is this same defect on the other axis, and the fix belongs in that hook next
 * to the read it has to race.
 */
export function useActiveView(
  api: LvisApi,
  /** View keys the app has actually loaded — `toViewKey` over `pluginViews`. */
  loadedPluginViewKeys: readonly string[],
  /** The focused pane — the location this hook restores into and persists from. */
  pane: ActiveViewPane,
): UseActiveViewResult {
  const activeView = pane.view;
  // The binding, as of the last render. Held in a ref so `setActiveView` and
  // the restore path keep ONE identity for the life of the app: the pane model
  // rebuilds `navigate` whenever pane content changes, and letting that reach
  // the callbacks would re-run the settings read on every navigation and hand
  // every dep-array-omitting call site a setter that no longer persists.
  const paneRef = useRef(pane);
  paneRef.current = pane;
  // Set by the first navigation and never cleared: the point after which the
  // user, not the stored value, says where the window is.
  //
  // A ref, not state, so `setActiveView` keeps ONE identity for the life of the
  // app. It stands in for a `useState` setter at call sites whose dep arrays
  // rightly omit it; an identity that changed the first time someone navigated
  // would leave those closures holding a setter that no longer persists. Being
  // a ref is also what lets the settings continuation — which closed over the
  // render that started the read — see a navigation made after it was created.
  const userNavigatedRef = useRef(false);
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
  //
  // Written from the pane on every render (the value is the source of truth, so
  // the write is idempotent) AND ahead of the commit by `applyView`, so two
  // navigations inside one tick still see each other — the same reading the
  // local `useState` gave before the value moved into the pane model.
  const activeViewRef = useRef<InlineViewKey>(activeView);
  activeViewRef.current = activeView;
  const applyView = useCallback((next: InlineViewKey) => {
    activeViewRef.current = next;
    paneRef.current.navigate(next);
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
        // The user got here first. A stored location that arrives after someone
        // has chosen one is stale by definition: entering it would move the
        // window off their choice, and merely HOLDING it (the plugin arm below)
        // would do the same the moment the view list loaded.
        if (userNavigatedRef.current) return;
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
      // Every caller of this is a deliberate destination: a sidebar or toolbar
      // row, the command palette, the app menu's `view:activate`, a clicked
      // notification, a back/forward replay. The only caller not traceable to a
      // user gesture — the uninstalled-plugin bounce in `usePluginViewRouting`
      // — is gated on `activeView` ALREADY being a `plugin:` key, which nothing
      // but a navigation or a completed restore can make it, so it cannot pass
      // for a choice the user has not made. The auth-gate drain in that same
      // hook also reaches here from an effect, but it replays a DEFERRED
      // gesture: its queue is filled only by the plugin row the user clicked
      // while that plugin was still unauthed.
      //
      // Read before the flag, because setting the flag is what stops this from
      // being the first navigation. The write at the bottom is the only reader.
      const firstNavigation = !userNavigatedRef.current;
      userNavigatedRef.current = true;
      // Retires a restore that already arrived and is waiting on its plugin
      // list; the flag above is what stops one that has not been read yet.
      setPendingPluginView(null);
      const current = activeViewRef.current;
      const resolved = typeof next === "function" ? next(current) : next;
      applyView(resolved);
      // Nothing is held back until the initial read resolves: the read can no
      // longer overwrite this, because the flag above has just discarded it.
      //
      // The FIRST navigation is written even when it resolves to the view the
      // window is already showing. Until one has been written, `current` is
      // whatever the mount seed or a restore left there, so `resolved ===
      // current` cannot tell "that value is already stored" apart from "the
      // stored one was discarded a line ago and nothing replaced it". Skipping
      // the write on the second reading is the same lost place by a slower
      // route the discard exists to prevent: re-selecting the row you are
      // already on during a slow launch would keep you here for this run and
      // reopen the discarded location at the next one. Writing on both readings
      // costs one redundant write in the first. From the second navigation on
      // the two do agree — nothing but this setter can move the window once the
      // flag is set, and it writes wherever it moves — so repeating a
      // destination genuinely has nothing to record.
      if (resolved !== current || firstNavigation) {
        void api.updateSettings({ system: { activeView: resolved } });
      }
    },
    [api, applyView],
  );

  return { activeView, setActiveView, restoresApplied };
}
