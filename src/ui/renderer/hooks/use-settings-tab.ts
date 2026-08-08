import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import { normalizeSettingsTab, type SettingsTab } from "../../../shared/settings-tabs.js";

export interface UseSettingsTabResult {
  /** Which settings page the inline panel is on. */
  settingsTab: SettingsTab;
  /** Set it — persists immediately, same family as `sidebarActiveTab`. */
  setSettingsTab: (tab: string) => void;
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

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const stored = settings?.system?.settingsTab;
        if (stored !== undefined) setSettingsTabState(normalizeSettingsTab(stored));
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

  return { settingsTab, setSettingsTab };
}
