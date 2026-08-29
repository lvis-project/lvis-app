/**
 * Test setup — pins the two ambient `Intl` inputs: the runtime locale and the
 * host time zone. Both decide what formatted output looks like, so leaving
 * either to the machine makes assertions mean different things on different
 * runners.
 *
 * ── Locale ──
 *
 * The test suite was written against the app's original Korean UI strings.
 * After the i18n migration those strings are served through `t()` with English
 * as the *default* locale, so under the default the suite would need ~1000
 * assertions rewritten to English. Instead we render in Korean for these tests:
 * every `t()` call resolves to the Korean catalog, so the existing Korean
 * assertions remain valid and meaningful (they now also assert the Korean
 * translation is wired correctly). The app's real default (English) is covered
 * by the i18n unit tests + settings defaults tests.
 *
 * ── Time zone ──
 *
 * Civil-day and clock-time projections follow the HOST zone by design, so a
 * suite that never states a zone asserts nothing more than "this machine agrees
 * with itself" — and passes on a developer's laptop while failing on CI. That
 * is not hypothetical: `usage-stats.test.ts` was green on a KST machine and
 * failed 8 tests under `America/New_York`.
 *
 * UTC is the default because it is what CI (ubuntu) runs in, so a local run
 * matches CI exactly.
 *
 * An explicit `TZ` from the caller wins, and that is the point rather than a
 * concession: it is what lets `TZ=America/New_York bun run test:vitest …` sweep
 * the suite across zones. A hard pin would silently swallow that argument and
 * make the sweep prove nothing. Suites with zone-specific fixtures re-pin
 * around their own assertions and restore afterwards.
 *
 * Wired via `setupFiles` for both projects in vitest.analysis.config.ts; it
 * runs once per test file (fresh module registry), so both are set before any
 * module under test formats anything.
 */
import { loadLocaleMessages } from "../messages/index.js";
import { setLocale } from "../runtime.js";

if (!process.env.TZ) process.env.TZ = "UTC";

await loadLocaleMessages("ko");
setLocale("ko");
