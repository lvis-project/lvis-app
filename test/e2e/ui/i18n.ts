import { interpolate, type TranslationVars } from '../../../src/i18n/translate.js';
import { messages, type Messages } from '../../../src/i18n/messages/index.js';
import { ko } from '../../../src/i18n/messages/ko.js';
import { koMessages } from '../../../src/i18n/messages/generated-locales/ko.js';

/**
 * i18n catalog binding for e2e assertions.
 *
 * Lets specs assert against a *catalog key* — `getByText(t('some.key'))` —
 * instead of a hard-coded Korean literal. The returned `t` is bound to the
 * locale the fixture seeds (`seedLocale`), so the same assertion passes whatever
 * locale the app renders, and the suite can flip its default to the production
 * English locale without rewriting every spec. (#1212 follow-up.)
 *
 * `translate` resolves active-locale → en fallback → the raw key, so a wrong /
 * removed key surfaces as a visible assertion failure (the key string is what
 * gets searched for) rather than a silent pass.
 */
export type TestT = (key: string, vars?: TranslationVars) => string;

export function makeTestT(locale: "en" | "ko"): TestT {
  // Production keeps non-English catalogs lazy. E2E assertions are synchronous,
  // so bind the locale that the harness can seed instead of racing the renderer's
  // dynamic import and accidentally asserting the English fallback.
  const catalog: Messages = locale === "ko" ? { ...ko, ...koMessages } : messages.en;
  return (key, vars) => interpolate(catalog[key] ?? messages.en[key] ?? key, vars);
}
