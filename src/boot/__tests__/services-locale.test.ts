import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LOCALE } from "../../i18n/locale.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";
import { translate } from "../../i18n/translate.js";
import {
  __resetLazyLocaleMessagesForTest,
  __setLocaleLoaderForTest,
  isLocaleMessagesLoaded,
} from "../../i18n/messages/index.js";
import { applyBootLocale } from "../services.js";

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
  __resetLazyLocaleMessagesForTest();
});

describe("applyBootLocale", () => {
  it("loads a persisted lazy locale before applying the main-process runtime locale", async () => {
    const settingsService = {
      get: () => ({ language: "zh" }),
    };

    setLocale(DEFAULT_LOCALE);
    __resetLazyLocaleMessagesForTest();
    expect(isLocaleMessagesLoaded("zh")).toBe(false);

    await applyBootLocale(settingsService);

    expect(isLocaleMessagesLoaded("zh")).toBe(true);
    expect(getLocale()).toBe("zh");
    expect(translate("zh", "settings.appearance.language.title")).toBe("语言");
  });

  it("falls back to English instead of failing boot when a lazy locale cannot load", async () => {
    const settingsService = {
      get: () => ({ language: "zh" }),
    };
    const restore = __setLocaleLoaderForTest("zh", () => Promise.reject(new Error("missing chunk")));

    try {
      setLocale("ko");

      await expect(applyBootLocale(settingsService)).resolves.toBeUndefined();

      expect(getLocale()).toBe("en");
      expect(translate("en", "settings.appearance.language.title")).toBe("Language");
    } finally {
      restore();
    }
  });
});
