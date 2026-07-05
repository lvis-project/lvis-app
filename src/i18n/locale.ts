/**
 * i18n locale definitions — single source of truth for supported languages.
 *
 * LVIS ships a global build with English as the default UI language. Supported
 * locales must have complete catalogs; a partially translated locale that
 * mostly falls back to English reads as a broken language switcher.
 *
 * This module is intentionally dependency-free so it can be imported from the
 * Electron main process, the renderer, and vitest without pulling in React or
 * Node-only APIs.
 */

/** Locales LVIS can render without broad English fallback. */
export const SUPPORTED_LOCALES = ["en", "ko", "ja", "zh", "es", "fr", "de"] as const;

/** A supported UI locale code (BCP-47 primary subtag). */
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Default UI locale for the global build. English-first. */
export const DEFAULT_LOCALE: Locale = "en";

/**
 * Locales shown in the default in-app language picker while translated
 * language packs move toward marketplace packages. The full `SUPPORTED_LOCALES`
 * union remains broad so existing settings and lazy catalogs keep working
 * during the migration.
 */
export const DEFAULT_VISIBLE_LOCALES = ["en"] as const satisfies readonly Locale[];

export type DefaultVisibleLocale = (typeof DEFAULT_VISIBLE_LOCALES)[number];

const DEFAULT_VISIBLE_LOCALE_SET = new Set<string>(DEFAULT_VISIBLE_LOCALES);

export type MarketplaceEligibleLocale = Exclude<Locale, DefaultVisibleLocale>;

export const MARKETPLACE_ELIGIBLE_LOCALES = SUPPORTED_LOCALES.filter(
  (locale): locale is MarketplaceEligibleLocale =>
    !DEFAULT_VISIBLE_LOCALE_SET.has(locale),
);

/**
 * Display metadata for the language picker. `nativeName` is shown to users in
 * their own language; `englishName` is a stable label for logs / fallback.
 */
export const LOCALE_INFO: Record<Locale, { nativeName: string; englishName: string }> = {
  en: { nativeName: "English", englishName: "English" },
  ko: { nativeName: "한국어", englishName: "Korean" },
  ja: { nativeName: "日本語", englishName: "Japanese" },
  zh: { nativeName: "简体中文", englishName: "Chinese (Simplified)" },
  es: { nativeName: "Español", englishName: "Spanish" },
  fr: { nativeName: "Français", englishName: "French" },
  de: { nativeName: "Deutsch", englishName: "German" },
};

/** Type guard: is `value` one of the supported locale codes? */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

export function isDefaultVisibleLocale(
  value: unknown,
): value is DefaultVisibleLocale {
  return (
    typeof value === "string" &&
    DEFAULT_VISIBLE_LOCALE_SET.has(value)
  );
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

export function visibleLocalesFor(currentLocales: readonly unknown[] = []): Locale[] {
  const visible: Locale[] = [...DEFAULT_VISIBLE_LOCALES];
  for (const value of currentLocales) {
    const locale = normalizeLocale(value);
    if (visible.includes(locale)) continue;
    visible.push(locale);
  }
  return visible;
}
