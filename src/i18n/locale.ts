/**
 * i18n locale definitions — single source of truth for supported languages.
 *
 * LVIS ships a global build with English as the default UI language. Korean
 * is a fully-translated secondary locale. The app reads the active locale
 * from `settings.appearance.language` (see {@link ../data/settings-store}),
 * defaulting to {@link DEFAULT_LOCALE} when unset or invalid.
 *
 * This module is intentionally dependency-free so it can be imported from the
 * Electron main process, the renderer, and vitest without pulling in React or
 * Node-only APIs.
 */

/** All locales LVIS can render its UI in. */
export const SUPPORTED_LOCALES = ["en", "ko"] as const;

/** A supported UI locale code (BCP-47 primary subtag). */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Default UI locale for the global build. English-first. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Display metadata for the language picker. `nativeName` is shown to users in
 * their own language; `englishName` is a stable label for logs / fallback.
 */
export const LOCALE_INFO: Record<Locale, { nativeName: string; englishName: string }> = {
  en: { nativeName: "English", englishName: "English" },
  ko: { nativeName: "한국어", englishName: "Korean" },
};

/** Type guard: is `value` one of the supported locale codes? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Coerce an arbitrary value (settings field, env var, navigator.language, …)
 * into a supported locale, falling back to {@link DEFAULT_LOCALE}.
 *
 * Accepts region-qualified tags (`en-US`, `ko-KR`) by matching the primary
 * subtag case-insensitively so a stored `"en-US"` still resolves to `"en"`.
 */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value !== "string") return DEFAULT_LOCALE;
  const primary = value.toLowerCase().split(/[-_]/)[0];
  return isLocale(primary) ? primary : DEFAULT_LOCALE;
}
