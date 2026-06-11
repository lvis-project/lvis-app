import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, normalizeLocale } from "../locale.js";
import { interpolate, translate } from "../translate.js";
import { getLocale, setLocale, t } from "../runtime.js";

beforeEach(() => {
  // This suite exercises the i18n default (English). The node test setup pins
  // the runtime locale to Korean for backend assertions, so reset to the
  // default here to test the real default-locale behavior.
  setLocale(DEFAULT_LOCALE);
});

afterEach(() => {
  // Reset module-level locale so tests don't leak ordering dependencies.
  setLocale(DEFAULT_LOCALE);
});

describe("locale", () => {
  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("isLocale only accepts supported codes", () => {
    expect(isLocale("en")).toBe(true);
    expect(isLocale("ko")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("normalizeLocale coerces region tags and falls back to default", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("ko_KR")).toBe("ko");
    expect(normalizeLocale("KO")).toBe("ko");
    expect(normalizeLocale("xx")).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
  });

  it("normalizeLocale handles OS locale tags from getPreferredSystemLanguages()", () => {
    // Electron's getPreferredSystemLanguages() returns BCP-47 tags like these.
    expect(normalizeLocale("ko-KR")).toBe("ko");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("zh-Hans-CN")).toBe("en"); // unsupported primary → English
    expect(normalizeLocale("ja-JP")).toBe("en");       // unsupported primary → English
  });
});

describe("interpolate", () => {
  it("substitutes provided vars", () => {
    expect(interpolate("Hello {name}", { name: "World" })).toBe("Hello World");
    expect(interpolate("{a}+{b}={c}", { a: 1, b: 2, c: 3 })).toBe("1+2=3");
  });

  it("leaves unmatched placeholders intact", () => {
    expect(interpolate("Hi {missing}", { name: "x" })).toBe("Hi {missing}");
  });

  it("returns template unchanged with no vars", () => {
    expect(interpolate("plain")).toBe("plain");
  });
});

describe("translate", () => {
  it("returns the locale-specific string", () => {
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("ko", "common.cancel")).toBe("취소");
  });

  it("falls back to English then to the key on a miss", () => {
    // A key absent everywhere returns itself (debuggable, not blank).
    expect(translate("ko", "totally.unknown.key")).toBe("totally.unknown.key");
  });
});

describe("runtime t()", () => {
  it("tracks the active locale and defaults to English", () => {
    expect(getLocale()).toBe("en");
    expect(t("common.save")).toBe("Save");
    setLocale("ko");
    expect(getLocale()).toBe("ko");
    expect(t("common.save")).toBe("저장");
  });

  it("normalizes the locale passed to setLocale", () => {
    setLocale("ko-KR");
    expect(getLocale()).toBe("ko");
  });
});
