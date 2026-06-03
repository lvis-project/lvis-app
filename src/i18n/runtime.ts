/**
 * Process-local active-locale holder + the ergonomic `t()` function.
 *
 * Both the Electron main process and the renderer keep their own module-level
 * locale here. It is set once at boot from persisted settings (and updated when
 * the user changes the language) so call sites can use the zero-argument-locale
 * form `t("some.key")` without threading a locale through every function.
 *
 * In React, the {@link ./react.I18nProvider} keeps this holder in sync AND
 * remounts its subtree on change, so module-level `t()` calls re-render with
 * the new language without each component needing the hook.
 */
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from "./locale.js";
import { translate, type TranslationVars } from "./translate.js";

let activeLocale: Locale = DEFAULT_LOCALE;

/** Listeners notified whenever the active locale changes (e.g. React provider). */
const listeners = new Set<(locale: Locale) => void>();

/** The current process-local UI locale. Defaults to English until set. */
export function getLocale(): Locale {
  return activeLocale;
}

/**
 * Set the process-local UI locale. Accepts any value (coerced via
 * {@link normalizeLocale}); a no-op when unchanged. Notifies subscribers.
 */
export function setLocale(value: unknown): Locale {
  const next = normalizeLocale(value);
  if (next === activeLocale) return activeLocale;
  activeLocale = next;
  for (const listener of listeners) listener(next);
  return next;
}

/** Subscribe to locale changes. Returns an unsubscribe function. */
export function onLocaleChange(listener: (locale: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Translate `key` using the current process-local locale.
 *
 * This is the primary, app-wide translation entry point. Import it anywhere
 * (main or renderer) and call `t("namespace.key", { name })`.
 */
export function t(key: string, vars?: TranslationVars): string {
  return translate(activeLocale, key, vars);
}
