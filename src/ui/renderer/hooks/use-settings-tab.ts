import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { normalizeSettingsTab, type SettingsTab } from "../../../shared/settings-tabs.js";
import { usePrefersReducedMotion } from "./use-prefers-reduced-motion.js";

export interface UseSettingsTabResult {
  /** Which settings page the inline panel is on. */
  settingsTab: SettingsTab;
  /** Set it — persists immediately, same family as `sidebarActiveTab`. */
  setSettingsTab: (tab: string) => void;
  /**
   * How many times THIS hook has applied the stored page. Monotonic, and read
   * the same way as `useActiveView.restoresApplied`: the tab is the other half
   * of the window's location, so a restore that lands here has to be
   * distinguishable from a user opening a settings page too.
   */
  restoresApplied: number;
}

/**
 * The settings panel's page, persisted alongside `activeView`.
 *
 * Restoring the location without this is a half-restore: someone who quits on
 * Settings → Permissions would come back to Settings → Model and read it as the
 * app losing their place. Both writers go through `normalizeSettingsTab`, which
 * also folds retired tab ids onto their replacements, so a value persisted by
 * an older build stays meaningful.
 */
export function useSettingsTab(api: LvisApi): UseSettingsTabResult {
  const [settingsTab, setSettingsTabState] = useState<SettingsTab>(() =>
    normalizeSettingsTab(undefined),
  );
  // A ref, not state: this setter stands in for a `useState` setter at call
  // sites whose dep arrays omit it, so its identity must never change.
  const hydratedRef = useRef(false);
  const [restoresApplied, setRestoresApplied] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const stored = settings?.system?.settingsTab;
        if (stored === undefined) return;
        setSettingsTabState(normalizeSettingsTab(stored));
        setRestoresApplied((applied) => applied + 1);
      })
      .catch(() => {
        // Non-fatal: the default tab is a valid place to land.
      })
      .finally(() => {
        if (!cancelled) hydratedRef.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setSettingsTab = useCallback(
    (tab: string) => {
      const normalized = normalizeSettingsTab(tab);
      setSettingsTabState(normalized);
      // Guard against persisting the seed back before the initial read resolves.
      if (!hydratedRef.current) return;
      void api.updateSettings({ system: { settingsTab: normalized } });
    },
    [api],
  );

  return { settingsTab, setSettingsTab, restoresApplied };
}

/**
 * How long the arrival ring stays on the section a deep link named.
 *
 * Long enough to be found by an eye that was reading a banner a moment ago,
 * short enough that it cannot be mistaken for a selected state.
 */
const SETTINGS_SECTION_ARRIVAL_MS = 1500;

/** The class `src/styles.css` draws the arrival ring with. */
export const SETTINGS_SECTION_ARRIVAL_CLASS = "lvis-settings-section-arrival";

/**
 * Land on the section a settings deep link named, once.
 *
 * The tab is persisted state; the section deliberately is not. It answers "the
 * user was just sent here", which is true for one arrival and false forever
 * after — persisting it would re-scroll and re-ring the same block every time
 * the panel opened, long after the notice that pointed at it was gone.
 * `onApplied` is how the caller drops the one-shot.
 *
 * Two effects rather than one, because the two lifetimes differ: the lookup
 * belongs to the target, the ring belongs to the node it was put on. Fused, the
 * state update `onApplied` causes would tear the ring off in the tick it was
 * added.
 */
export function useSettingsSectionArrival(
  section: string | null,
  onApplied: () => void,
): void {
  const [ringed, setRinged] = useState<HTMLElement | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  // Read through a ref, not a dependency. Arrival is one event: re-running the
  // effect because the OS toggle flipped would scroll and re-ring a section the
  // user navigated away from reading minutes ago.
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  useEffect(() => {
    if (section === null) return;
    // A frame late: the tab body mounts in the same commit that set the
    // target, so the anchor does not exist yet when this effect first runs.
    const frame = requestAnimationFrame(() => {
      const node = document.querySelector<HTMLElement>(
        `[data-settings-section="${section}"]`,
      );
      if (node) {
        node.scrollIntoView({
          block: "start",
          behavior: reducedMotionRef.current ? "auto" : "smooth",
        });
        // The scroll already put the section where it belongs; focusing with
        // `preventScroll` moves the keyboard caret there without a second jump.
        node.focus({ preventScroll: true });
        setRinged(node);
      }
      // Consumed either way. An anchor this build cannot find is still an
      // arrival that happened — leaving the target set would retry it on every
      // later render of the panel.
      onApplied();
    });
    return () => cancelAnimationFrame(frame);
  }, [section, onApplied]);

  useEffect(() => {
    if (ringed === null) return;
    ringed.classList.add(SETTINGS_SECTION_ARRIVAL_CLASS);
    const timer = setTimeout(() => setRinged(null), SETTINGS_SECTION_ARRIVAL_MS);
    return () => {
      clearTimeout(timer);
      ringed.classList.remove(SETTINGS_SECTION_ARRIVAL_CLASS);
    };
  }, [ringed]);
}
