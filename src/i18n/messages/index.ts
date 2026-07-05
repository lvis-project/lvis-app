/**
 * Locale → message-catalog registry.
 *
 * Each locale's catalog is the union of:
 *   - the hand-curated *seed* (common keys: {@link ./en} and language-pack seeds), and
 *   - the *generated* per-surface fragments ({@link ./generated}), produced by
 *     the i18n migration and assembled by `scripts/i18n-build-catalog.mjs`.
 *
 * Generated entries override seed entries on key collision (the surface-
 * specific text wins), though namespacing keeps collisions out of practice.
 */
import type { Locale } from "../locale.js";
import { en } from "./en.js";
import { generatedEn } from "./generated/index.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../locale.js";

const englishFallbackMessages: Messages = { ...en, ...generatedEn };

/**
 * Any translation key. The full key space is open (`string`) because surface
 * keys are merged in from generated fragments; lookups fall back to English
 * and then to the key itself, so an unknown key is visible, never blank.
 */
export type MessageKey = string;

/** A message catalog: every key mapped to a localized string. */
export type Messages = Record<string, string>;

export type MessageRegistry = Partial<Record<Locale, Messages>> & {
  en: Messages;
};

/**
 * Loaded catalogs, keyed by locale. Only English is eager: the global default
 * UI language and fallback catalog must be synchronous. Every other locale is
 * a language-pack catalog loaded on demand.
 */
export const messages: MessageRegistry = {
  en: englishFallbackMessages,
};

type LazyLocale = Exclude<Locale, "en">;

const lazyLocales: readonly LazyLocale[] = ["ko", "ja", "zh", "es", "fr", "de"];

const localeLoaders: Record<LazyLocale, () => Promise<Messages>> = {
  async ko() {
    const [{ ko }, { koMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-ko-seed" */ "./ko.js"),
      import(/* webpackChunkName: "i18n-ko" */ "./generated-locales/ko.js"),
    ]);
    return { ...ko, ...koMessages };
  },
  async ja() {
    const [{ ja }, { jaMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-ja-seed" */ "./ja.js"),
      import(/* webpackChunkName: "i18n-ja" */ "./generated-locales/ja.js"),
    ]);
    return { ...jaMessages, ...ja };
  },
  async zh() {
    const [{ zh }, { zhMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-zh-seed" */ "./zh.js"),
      import(/* webpackChunkName: "i18n-zh" */ "./generated-locales/zh.js"),
    ]);
    return { ...zhMessages, ...zh };
  },
  async es() {
    const [{ es }, { esMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-es-seed" */ "./es.js"),
      import(/* webpackChunkName: "i18n-es" */ "./generated-locales/es.js"),
    ]);
    return { ...esMessages, ...es };
  },
  async fr() {
    const [{ fr }, { frMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-fr-seed" */ "./fr.js"),
      import(/* webpackChunkName: "i18n-fr" */ "./generated-locales/fr.js"),
    ]);
    return { ...frMessages, ...fr };
  },
  async de() {
    const [{ de }, { deMessages }] = await Promise.all([
      import(/* webpackChunkName: "i18n-de-seed" */ "./de.js"),
      import(/* webpackChunkName: "i18n-de" */ "./generated-locales/de.js"),
    ]);
    return { ...deMessages, ...de };
  },
};

const pendingLoads = new Map<Locale, Promise<Messages>>();

export function isLocaleMessagesLoaded(locale: Locale): boolean {
  return messages[locale] !== undefined;
}

export async function loadLocaleMessages(locale: Locale): Promise<Messages> {
  const existing = messages[locale];
  if (existing) return existing;
  const pending = pendingLoads.get(locale);
  if (pending) return pending;
  const loader = localeLoaders[locale as LazyLocale];
  const next = loader().then((catalog) => {
    messages[locale] = catalog;
    pendingLoads.delete(locale);
    return catalog;
  }, (err) => {
    pendingLoads.delete(locale);
    throw err;
  });
  pendingLoads.set(locale, next);
  return next;
}

export async function tryLoadLocaleMessages(locale: Locale): Promise<boolean> {
  try {
    await loadLocaleMessages(locale);
    return true;
  } catch {
    if (locale !== DEFAULT_LOCALE) {
      await loadLocaleMessages(DEFAULT_LOCALE);
    }
    return false;
  }
}

export async function loadAllLocaleMessages(): Promise<Record<Locale, Messages>> {
  await Promise.all(SUPPORTED_LOCALES.map((locale) => loadLocaleMessages(locale)));
  return messages as Record<Locale, Messages>;
}

/** @internal Test-only reset for suites that assert lazy initial state. */
export function __resetLazyLocaleMessagesForTest(): void {
  for (const locale of lazyLocales) {
    delete messages[locale];
    pendingLoads.delete(locale);
  }
}

/** @internal Test-only loader override for pending/error-path coverage. */
export function __setLocaleLoaderForTest(
  locale: LazyLocale,
  loader: () => Promise<Messages>,
): () => void {
  const previous = localeLoaders[locale];
  localeLoaders[locale] = loader;
  delete messages[locale];
  pendingLoads.delete(locale);
  return () => {
    localeLoaders[locale] = previous;
    delete messages[locale];
    pendingLoads.delete(locale);
  };
}
