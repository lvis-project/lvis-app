import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCALE,
  DEFAULT_VISIBLE_LOCALES,
  MARKETPLACE_ELIGIBLE_LOCALES,
  SUPPORTED_LOCALES,
  isDefaultVisibleLocale,
  isLocale,
  normalizeLocale,
  visibleLocalesFor,
} from "../locale.js";
import {
  __resetLazyLocaleMessagesForTest,
  __setLocaleLoaderForTest,
  isLocaleMessagesLoaded,
  loadAllLocaleMessages,
  loadLocaleMessages,
  messages,
} from "../messages/index.js";
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
  __resetLazyLocaleMessagesForTest();
});

afterEach(() => {
  // Reset module-level locale so tests don't leak ordering dependencies.
  setLocale(DEFAULT_LOCALE);
  __resetLazyLocaleMessagesForTest();
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

  it("shows only English in the default language surface", () => {
    expect(DEFAULT_VISIBLE_LOCALES).toEqual(["en"]);
    expect(isDefaultVisibleLocale("en")).toBe(true);
    expect(isDefaultVisibleLocale("ko")).toBe(false);
    expect(MARKETPLACE_ELIGIBLE_LOCALES).toEqual(["ko", "ja", "zh", "es", "fr", "de"]);
    expect(visibleLocalesFor(["ko-KR"])).toEqual(["en", "ko"]);
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
  it("keeps extra generated locales lazy until explicitly loaded", () => {
    expect(isLocaleMessagesLoaded("en")).toBe(true);
    expect(isLocaleMessagesLoaded("ko")).toBe(true);
    expect(isLocaleMessagesLoaded("ja")).toBe(false);
    expect(isLocaleMessagesLoaded("zh")).toBe(false);
  });

  it("coalesces concurrent lazy locale loads", async () => {
    const catalog = { ...messages.en, "common.cancel": "Concurrent OK" };
    const loader = vi.fn(() => Promise.resolve(catalog));
    const restore = __setLocaleLoaderForTest("ja", loader);

    try {
      const first = loadLocaleMessages("ja");
      const second = loadLocaleMessages("ja");

      const [firstCatalog, secondCatalog] = await Promise.all([first, second]);

      expect(loader).toHaveBeenCalledTimes(1);
      expect(firstCatalog).toBe(secondCatalog);
      expect(firstCatalog).toBe(catalog);
      expect(isLocaleMessagesLoaded("ja")).toBe(true);
    } finally {
      restore();
    }
  });

  it("clears a failed pending lazy locale load so a retry can succeed", async () => {
    const retryCatalog = { ...messages.en, "common.cancel": "Retry OK" };
    const loader = vi.fn()
      .mockRejectedValueOnce(new Error("temporary chunk failure"))
      .mockResolvedValueOnce(retryCatalog);
    const restore = __setLocaleLoaderForTest("ja", loader);

    try {
      await expect(loadLocaleMessages("ja")).rejects.toThrow("temporary chunk failure");
      expect(isLocaleMessagesLoaded("ja")).toBe(false);

      await expect(loadLocaleMessages("ja")).resolves.toBe(retryCatalog);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(translate("ja", "common.cancel")).toBe("Retry OK");
    } finally {
      restore();
    }
  });

  it("returns the locale-specific string", async () => {
    await Promise.all(SUPPORTED_LOCALES.map((locale) => loadLocaleMessages(locale)));
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

  it("ships complete catalogs for every supported locale", async () => {
    const catalogs = await loadAllLocaleMessages();
    const englishKeys = Object.keys(catalogs.en).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(englishKeys);
    }
  });

  it("preserves placeholder and tag parity in every supported locale", async () => {
    const catalogs = await loadAllLocaleMessages();
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, english] of Object.entries(catalogs.en)) {
        expect(sortedMatches(catalogs[locale][key] ?? "", PLACEHOLDER_RE), `${locale}:${key}:placeholders`)
          .toEqual(sortedMatches(english, PLACEHOLDER_RE));
        expect(sortedMatches(catalogs[locale][key] ?? "", TAG_RE), `${locale}:${key}:tags`)
          .toEqual(sortedMatches(english, TAG_RE));
        expect(sortedMatches(catalogs[locale][key] ?? "", SLASH_COMMAND_RE), `${locale}:${key}:slashCommands`)
          .toEqual(sortedMatches(english, SLASH_COMMAND_RE));
      }
    }
  });

  it("does not expose generated protection sentinels", async () => {
    const catalogs = await loadAllLocaleMessages();
    for (const locale of SUPPORTED_LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value, `${locale}:${key}`).not.toMatch(SENTINEL_LEAK_RE);
      }
    }
  });

  it("does not expose Japanese and Chinese as English fallback catalogs", async () => {
    await Promise.all([loadLocaleMessages("ja"), loadLocaleMessages("zh")]);
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
