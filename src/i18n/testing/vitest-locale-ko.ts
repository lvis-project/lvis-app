/**
 * Renderer (jsdom) test setup — pins the i18n runtime locale to Korean.
 *
 * The renderer test suite was written against the app's original Korean UI
 * strings. After the i18n migration those strings are served through `t()`
 * with English as the *default* locale, so under the default the suite would
 * need ~1000 assertions rewritten to English. Instead we render the components
 * in Korean for these tests: every `t()` call resolves to the Korean catalog,
 * so the existing Korean assertions remain valid and meaningful (they now also
 * assert the Korean translation is wired correctly). The app's real default
 * (English) is covered by the i18n unit tests + settings defaults tests.
 *
 * Wired via `setupFiles` for the `jsdom` project in vitest.config.ts; it runs
 * once per test file (fresh module registry), so the locale is set before any
 * component renders.
 */
import { setLocale } from "../runtime.js";

setLocale("ko");
