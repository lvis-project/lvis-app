/**
 * React bindings for i18n (renderer-only).
 *
 * `I18nProvider` is a *controlled* provider: the owning renderer component
 * supplies the active `locale` and a `setLocale` callback (which typically
 * persists to settings). The provider:
 *   1. mirrors the locale into the module-level runtime so non-hook `t()`
 *      callers resolve against the right language on this render, and
 *   2. remounts its subtree via `key={locale}` so components that import the
 *      module-level `t` (instead of the hook) still re-render on a language
 *      switch.
 *
 * Main process never imports this file, so React stays out of the main bundle.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { type Locale } from "./locale.js";
import { getLocale, setLocale as setRuntimeLocale, t as runtimeT } from "./runtime.js";
import type { TranslationVars } from "./translate.js";

export interface I18nContextValue {
  locale: Locale;
  /** Change the active language (persists + re-renders the app). */
  setLocale: (locale: Locale) => void;
  /** Translate a key against the active locale. */
  t: (key: string, vars?: TranslationVars) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Access the active locale, a setter, and `t`. Safe to call without a
 * provider (e.g. an isolated component test): it falls back to the
 * module-level runtime so components never crash for lack of a provider.
 */
export function useTranslation(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  return {
    locale: getLocale(),
    setLocale: (locale: Locale) => setRuntimeLocale(locale),
    t: runtimeT,
  };
}

export interface I18nProviderProps {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  children: ReactNode;
}

export function I18nProvider({ locale, setLocale, children }: I18nProviderProps) {
  // Keep the module-level runtime in sync so `t()` (imported directly, not via
  // the hook — e.g. in event callbacks or non-React utils) resolves against the
  // active `locale`. The context value below is keyed on `locale`, so hook
  // consumers (`useTranslation`) re-render on a language switch WITHOUT
  // remounting — preserving component state (open chat, scroll position, …).
  setRuntimeLocale(locale);
  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: (key, vars) => runtimeT(key, vars) }),
    [locale, setLocale],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
