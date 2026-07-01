/**
 * Locale → message-catalog registry.
 *
 * Each locale's catalog is the union of:
 *   - the hand-curated *seed* (common keys: {@link ./en} / {@link ./ko}), and
 *   - the *generated* per-surface fragments ({@link ./generated}), produced by
 *     the i18n migration and assembled by `scripts/i18n-build-catalog.mjs`.
 *
 * Generated entries override seed entries on key collision (the surface-
 * specific text wins), though namespacing keeps collisions out of practice.
 */
import type { Locale } from "../locale.js";
import { de as deSeed } from "./de.js";
import { en } from "./en.js";
import { es as esSeed } from "./es.js";
import { fr as frSeed } from "./fr.js";
import { ja as jaSeed } from "./ja.js";
import { ko } from "./ko.js";
import { zh as zhSeed } from "./zh.js";
import { generatedEn, generatedKo } from "./generated/index.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../locale.js";

const englishFallbackMessages: Messages = { ...en, ...generatedEn };
const koreanMessages: Messages = { ...ko, ...generatedKo };

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
  ko: Messages;
};

/**
 * Loaded catalogs, keyed by locale. `en` and `ko` are eager because the default
 * English fallback and the Korean test/runtime surface are synchronous. The
 * larger generated extra-locale catalogs are filled by `loadLocaleMessages`.
 */
export const messages: MessageRegistry = {
  en: englishFallbackMessages,
  ko: koreanMessages,
};

type LazyLocale = Exclude<Locale, "en" | "ko">;

const lazyLocales: readonly LazyLocale[] = ["ja", "zh", "es", "fr", "de"];

const localeLoaders: Record<LazyLocale, () => Promise<Messages>> = {
  async ja() {
    const { jaMessages } = await import(
      /* webpackChunkName: "i18n-ja" */ "./generated-locales/ja.js"
    );
    return { ...jaMessages, ...jaSeed };
  },
  async zh() {
    const { zhMessages } = await import(
      /* webpackChunkName: "i18n-zh" */ "./generated-locales/zh.js"
    );
    return { ...zhMessages, ...zhSeed };
  },
  async es() {
    const { esMessages } = await import(
      /* webpackChunkName: "i18n-es" */ "./generated-locales/es.js"
    );
    return { ...esMessages, ...esSeed };
  },
  async fr() {
    const { frMessages } = await import(
      /* webpackChunkName: "i18n-fr" */ "./generated-locales/fr.js"
    );
    return { ...frMessages, ...frSeed };
  },
  async de() {
    const { deMessages } = await import(
      /* webpackChunkName: "i18n-de" */ "./generated-locales/de.js"
    );
    return { ...deMessages, ...deSeed };
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
  const loader = localeLoaders[locale as Exclude<Locale, "en" | "ko">];
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
