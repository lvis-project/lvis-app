/**
 * Renderer composition glue for i18n.
 *
 * Wraps the pure {@link I18nProvider} with settings-backed locale state:
 *   - hydrates the active language from `settings.appearance.language` on mount,
 *   - stays in sync across windows via `api.onSettingsUpdated` (the same
 *     cross-window broadcast ThemeProvider uses), and
 *   - persists a language change through `api.updateSettings`.
 *
 * Defensive against a missing preload bridge (isolated component tests) — when
 * `window.lvisApi` is absent it simply renders children at the English default.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  DEFAULT_LOCALE,
  normalizeLocale,
  tryLoadLocaleMessages,
  type Locale,
} from "../../../i18n/index.js";
import { I18nProvider } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import type { LvisApi } from "../types.js";

/** `getApi()` throws when the preload bridge is absent; degrade gracefully. */
function tryGetApi(): LvisApi | null {
  try {
    return getApi();
  } catch {
    return null;
  }
}

export function I18nSettingsProvider({ children }: { children: ReactNode }) {
  const api = useMemo(() => tryGetApi(), []);
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const mountedRef = useRef(true);
  const localeRequestRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const applyLocale = useCallback(async (next: Locale) => {
    const requestId = ++localeRequestRef.current;
    const loaded = await tryLoadLocaleMessages(next);
    if (!mountedRef.current || requestId !== localeRequestRef.current) return;
    if (!loaded) return;
    setLocaleState(next);
  }, []);

  // Hydrate from persisted settings on mount.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    const requestAtStart = localeRequestRef.current;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || !mountedRef.current) return;
        if (localeRequestRef.current !== requestAtStart) return;
        await applyLocale(normalizeLocale(settings.appearance?.language));
      } catch {
        /* ignore — render continues at the English default */
      }
    })();
    return () => { cancelled = true; };
  }, [api, applyLocale]);

  // Cross-window sync: a language change in the settings window broadcasts to
  // every renderer so the main window re-localizes without a restart.
  useEffect(() => {
    if (!api?.onSettingsUpdated) return;
    return api.onSettingsUpdated((settings) => {
      if (!mountedRef.current) return;
      void applyLocale(normalizeLocale(settings.appearance?.language));
    });
  }, [api, applyLocale]);

  const setLocale = useCallback(
    (next: Locale) => {
      void applyLocale(next);
      if (api) {
        void api
          .updateSettings({ appearance: { schemaVersion: 2, language: next } })
          .catch(() => { /* ignore — local state already reflects the choice */ });
      }
    },
    [api, applyLocale],
  );

  return (
    <I18nProvider locale={locale} setLocale={setLocale}>
      {children}
    </I18nProvider>
  );
}
