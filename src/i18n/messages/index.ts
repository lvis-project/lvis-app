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
import { deMessages } from "./generated-locales/de.js";
import { esMessages } from "./generated-locales/es.js";
import { frMessages } from "./generated-locales/fr.js";
import { jaMessages } from "./generated-locales/ja.js";
import { zhMessages } from "./generated-locales/zh.js";

const englishFallbackMessages: Messages = { ...en, ...generatedEn };
const koreanMessages: Messages = { ...ko, ...generatedKo };
const japaneseMessages: Messages = { ...jaMessages, ...jaSeed };
const chineseMessages: Messages = { ...zhMessages, ...zhSeed };
const spanishMessages: Messages = { ...esMessages, ...esSeed };
const frenchMessages: Messages = { ...frMessages, ...frSeed };
const germanMessages: Messages = { ...deMessages, ...deSeed };

/**
 * Any translation key. The full key space is open (`string`) because surface
 * keys are merged in from generated fragments; lookups fall back to English
 * and then to the key itself, so an unknown key is visible, never blank.
 */
export type MessageKey = string;

/** A message catalog: every key mapped to a localized string. */
export type Messages = Record<string, string>;

/** All catalogs, keyed by locale. Consumed by {@link ../translate.translate}. */
export const messages: Record<Locale, Messages> = {
  en: englishFallbackMessages,
  ko: koreanMessages,
  ja: japaneseMessages,
  zh: chineseMessages,
  es: spanishMessages,
  fr: frenchMessages,
  de: germanMessages,
};
