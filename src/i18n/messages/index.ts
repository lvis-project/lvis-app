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
import { en } from "./en.js";
import { ko } from "./ko.js";
import { generatedEn, generatedKo } from "./generated/index.js";

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
  en: { ...en, ...generatedEn },
  ko: { ...ko, ...generatedKo },
};
