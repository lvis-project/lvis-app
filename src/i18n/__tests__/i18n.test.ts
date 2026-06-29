import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, isLocale, normalizeLocale } from "../locale.js";
import { messages } from "../messages/index.js";
import { interpolate, translate } from "../translate.js";
import { getLocale, setLocale, t } from "../runtime.js";

const PLACEHOLDER_RE = /\{[A-Za-z0-9_.-]+\}/g;
const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s+[^<>]*)?>/g;
const SLASH_COMMAND_RE = /\/(?:new|sessions|load|compact|remember|memory|vendor|tools|permission|help|clear|command)\b/g;
const SENTINEL_LEAK_RE = /LVISKEEP\s*\d+/i;

function sortedMatches(value: string, pattern: RegExp): string[] {
  return value.match(pattern)?.sort() ?? [];
}

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
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("zh")).toBe(true);
    expect(isLocale("es")).toBe(true);
    expect(isLocale("fr")).toBe(true);
    expect(isLocale("de")).toBe(true);
    expect(isLocale("it")).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it("normalizeLocale coerces region tags and falls back to default", () => {
    expect(normalizeLocale("en-US")).toBe("en");
    expect(normalizeLocale("ko_KR")).toBe("ko");
    expect(normalizeLocale("KO")).toBe("ko");
    expect(normalizeLocale("fr-FR")).toBe("fr");
    expect(normalizeLocale("xx")).toBe("en");
    expect(normalizeLocale(undefined)).toBe("en");
  });

  it("normalizeLocale handles OS locale tags from getPreferredSystemLanguages()", () => {
    // Electron's getPreferredSystemLanguages() returns BCP-47 tags like these.
    expect(normalizeLocale("ko-KR")).toBe("ko");
    expect(normalizeLocale("en-GB")).toBe("en");
    expect(normalizeLocale("zh-Hans-CN")).toBe("zh");
    expect(normalizeLocale("ja-JP")).toBe("ja");
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
    expect(translate("ja", "common.cancel")).toBe("キャンセル");
    expect(translate("zh", "common.cancel")).toBe("取消");
    expect(translate("es", "common.cancel")).toBe("Cancelar");
    expect(translate("fr", "common.cancel")).toBe("Annuler");
    expect(translate("de", "common.cancel")).toBe("Abbrechen");
  });

  it("falls back to English then to the key on a miss", () => {
    expect(translate("ko", "chatTab.streamSmoothingTitle")).toBe("스트림 부드럽게 표시 (Stream Smoothing)");
    // A key absent everywhere returns itself (debuggable, not blank).
    expect(translate("ko", "totally.unknown.key")).toBe("totally.unknown.key");
  });

  it("ships complete catalogs for every supported locale", () => {
    const englishKeys = Object.keys(messages.en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(messages[locale]).sort(), locale).toEqual(englishKeys);
    }
  });

  it("preserves placeholder and tag parity in every supported locale", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, english] of Object.entries(messages.en)) {
        expect(sortedMatches(messages[locale][key] ?? "", PLACEHOLDER_RE), `${locale}:${key}:placeholders`)
          .toEqual(sortedMatches(english, PLACEHOLDER_RE));
        expect(sortedMatches(messages[locale][key] ?? "", TAG_RE), `${locale}:${key}:tags`)
          .toEqual(sortedMatches(english, TAG_RE));
        expect(sortedMatches(messages[locale][key] ?? "", SLASH_COMMAND_RE), `${locale}:${key}:slashCommands`)
          .toEqual(sortedMatches(english, SLASH_COMMAND_RE));
      }
    }
  });

  it("does not expose generated protection sentinels", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(messages[locale])) {
        expect(value, `${locale}:${key}`).not.toMatch(SENTINEL_LEAK_RE);
      }
    }
  });

  it("does not expose Japanese and Chinese as English fallback catalogs", () => {
    expect(translate("ja", "chatTab.streamSmoothingTitle")).not.toBe("Stream Smoothing");
    expect(translate("zh", "chatTab.streamSmoothingTitle")).not.toBe("Stream Smoothing");
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
    setLocale("de-DE");
    expect(getLocale()).toBe("de");
  });
});
