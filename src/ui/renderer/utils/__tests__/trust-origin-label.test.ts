// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
/**
 * The transcript's provenance chip.
 *
 * The staged half is resolved through the staged-origin registry, so registering
 * an origin labels it. Before that, this was a hand-written switch with
 * `default: return origin` — a registered origin nobody remembered to add here
 * rendered its raw kebab-case string at the user, in every locale.
 */
import { describe, expect, it } from "vitest";
import { generatedEn } from "../../../../i18n/messages/generated/index.js";
import { STAGED_ORIGIN_KINDS } from "../../../../shared/staged-origins.js";
import { isNonUserTrustOrigin, trustOriginLabel } from "../trust-origin-label.js";

describe("trustOriginLabel", () => {
  it("labels every registered staged origin through the table", () => {
    const catalog = generatedEn as Record<string, string>;
    for (const kind of STAGED_ORIGIN_KINDS) {
      expect(catalog[kind.labelKey], `missing i18n key ${kind.labelKey}`).toBeTypeOf("string");
      const label = trustOriginLabel(kind.inputOrigin);
      expect(label.length).toBeGreaterThan(0);
      // The failure this guards: the raw origin string reaching the UI.
      expect(label).not.toBe(kind.inputOrigin);
    }
  });

  it("labels the non-staged origins the table does not own", () => {
    for (const origin of ["user-keyboard", "llm-tool-arg", "file-content", undefined]) {
      const label = trustOriginLabel(origin);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(origin);
    }
  });

  it("shows an unknown origin verbatim rather than blank", () => {
    // Deliberate: an origin that reaches the UI unlabeled should be visible.
    expect(trustOriginLabel("something-new")).toBe("something-new");
  });

  it("treats every origin except the keyboard as non-user", () => {
    expect(isNonUserTrustOrigin("user-keyboard")).toBe(false);
    for (const kind of STAGED_ORIGIN_KINDS) {
      expect(isNonUserTrustOrigin(kind.inputOrigin)).toBe(true);
    }
    expect(isNonUserTrustOrigin(undefined)).toBe(true);
  });
});
