import { translate, type TranslationVars } from '../../../src/i18n/translate.js';
import type { Locale } from '../../../src/i18n/locale.js';

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

export function makeTestT(locale: Locale): TestT {
  return (key, vars) => translate(locale, key, vars);
}
