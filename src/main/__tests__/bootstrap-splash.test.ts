/**
 * Splash status keys must resolve.
 *
 * `translate()` falls back to English and then to the key itself on a miss, so
 * a renamed or mistyped catalog key does not throw — it renders the raw key
 * (`be_main.bootstrapStatusOpeningWorkspace`) as the splash status line, which
 * is the very first thing a user sees. `t()` takes a plain `string`, so the
 * compiler does not catch it either.
 *
 * This reads the literals out of the module source rather than re-listing
 * them, so adding or renaming a splash message is covered without editing the
 * test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatedEn } from "../../i18n/messages/generated/index.js";
import { t } from "../../i18n/index.js";

const SOURCE = resolve(import.meta.dirname, "../bootstrap-splash.ts");

/** Every `t("...")` literal the splash module names, read from its source. */
function splashKeysFromSource(): string[] {
  const source = readFileSync(SOURCE, "utf-8");
  return [...source.matchAll(/\bt\("([^"]+)"\)/g)].map((m) => m[1]!);
}

describe("bootstrap splash status messages", () => {
  it("resolves every t() key the splash module names", () => {
    const keys = splashKeysFromSource();
    expect(keys.length).toBeGreaterThan(0);
    const catalog = generatedEn as Record<string, string>;
    for (const key of keys) {
      expect(catalog[key], `missing i18n key ${key}`).toBeTypeOf("string");
    }
  });

  it("serves markup carrying translated status lines, not raw keys", async () => {
    const { BOOTSTRAP_SPLASH } = await import("../bootstrap-splash.js");
    const keys = splashKeysFromSource();
    expect(keys.length).toBeGreaterThan(0);
    // The <p id="status"> seed, the JSON-encoded idle-cycle array and the
    // version-panel aria-label are all interpolated into BOOTSTRAP_SPLASH, so a
    // key that failed to resolve would reach the served HTML verbatim.
    expect(BOOTSTRAP_SPLASH).not.toMatch(/be_main\.[A-Za-z]/);
    // Derived from the module source rather than re-listed, so renaming a key
    // (module + all catalogs) or adding a message needs no edit here.
    for (const key of keys) {
      expect(
        BOOTSTRAP_SPLASH,
        `splash markup is missing the translation of ${key}`,
      ).toContain(t(key));
    }
  });
});
