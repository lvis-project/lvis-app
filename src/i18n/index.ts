/**
 * i18n barrel — process-agnostic surface (no React).
 *
 * Import from here in main-process and shared code:
 *   `import { t, setLocale } from "../i18n/index.js";`
 * Renderer React code additionally imports `./react.js` for the provider/hook.
 */
export {
  DEFAULT_VISIBLE_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_INFO,
  MARKETPLACE_ELIGIBLE_LOCALES,
  SUPPORTED_LOCALES,
  isDefaultVisibleLocale,
  isLocale,
  isMarketplaceEligibleLocale,
  normalizeLocale,
  recommendedMarketplaceLocaleForSystem,
  visibleLocalesFor,
  type Locale,
} from "./locale.js";
export { getLocale, onLocaleChange, setLocale, t } from "./runtime.js";
export { interpolate, translate, type TranslationVars } from "./translate.js";
export {
  isLocaleMessagesLoaded,
  loadAllLocaleMessages,
  loadLocaleMessages,
  tryLoadLocaleMessages,
  type MessageKey,
  type Messages,
} from "./messages/index.js";
