/**
 * The skip vocabulary and its two renderings.
 *
 * `BootstrapSkipReason` is closed so the renderer can translate it, and the two
 * tables that render it — operator log prose and an i18n key — sit beside the
 * union for the same reason. That only holds if both tables actually cover the
 * union and the keys they name exist, so both are checked here.
 *
 * The message-key check has to live somewhere: `t(TABLE[code])` is a computed
 * key, and the literal scan in `src/i18n/__tests__/used-keys-exist.test.ts`
 * matches `t("literal")` only — a key reached through a table is invisible to
 * it, resolves to itself at runtime, and ships as a raw dotted string in the
 * UI. Nothing else would catch that before someone looked at the app.
 */
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_SKIP_MESSAGE_KEY,
  describeBootstrapSkip,
  type BootstrapSkipReason,
} from "../bootstrap-status.js";
import { SUPPORTED_LOCALES } from "../../i18n/locale.js";
import { loadAllLocaleMessages } from "../../i18n/messages/index.js";

const REASONS: BootstrapSkipReason[] = [
  "e2e-isolated",
  "no-base-url",
  "catalog-unreachable",
];

describe("describeBootstrapSkip", () => {
  it("writes log prose from the code alone", () => {
    expect(describeBootstrapSkip({ reason: "e2e-isolated" })).toBe(
      "managed plugin bootstrap disabled in isolated E2E test mode",
    );
    expect(describeBootstrapSkip({ reason: "no-base-url" })).toBe(
      "marketplace backend has no configured base URL",
    );
  });

  it("appends the network boundary's own message when the catalog was the skip", () => {
    expect(
      describeBootstrapSkip({
        reason: "catalog-unreachable",
        detail: "ENOTFOUND marketplace",
      }),
    ).toBe("catalog unreachable: ENOTFOUND marketplace");
  });

  it("says something for every code in the union", () => {
    for (const reason of REASONS) {
      expect(describeBootstrapSkip({ reason })).not.toBe("");
    }
  });
});

describe("BOOTSTRAP_SKIP_MESSAGE_KEY", () => {
  it("names a distinct key for every code", () => {
    const keys = REASONS.map((reason) => BOOTSTRAP_SKIP_MESSAGE_KEY[reason]);
    expect(keys.filter(Boolean)).toHaveLength(REASONS.length);
    expect(new Set(keys).size).toBe(REASONS.length);
  });

  it("names keys that resolve in every supported locale", async () => {
    const catalogs = await loadAllLocaleMessages();
    const missing: string[] = [];
    for (const reason of REASONS) {
      const key = BOOTSTRAP_SKIP_MESSAGE_KEY[reason];
      for (const locale of SUPPORTED_LOCALES) {
        if (!Object.hasOwn(catalogs[locale], key)) missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
