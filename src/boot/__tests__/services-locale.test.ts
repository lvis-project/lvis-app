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
      get: () => ({ language: "ko" }),
    };

    setLocale(DEFAULT_LOCALE);
    __resetLazyLocaleMessagesForTest();
    expect(isLocaleMessagesLoaded("ko")).toBe(false);

    await applyBootLocale(settingsService);

    expect(isLocaleMessagesLoaded("ko")).toBe(true);
    expect(getLocale()).toBe("ko");
    expect(translate("ko", "settings.appearance.language.title")).toBe("언어");
  });

  it("falls back to English instead of failing boot when a lazy locale cannot load", async () => {
    const settingsService = {
      get: () => ({ language: "ko" }),
    };
    const restore = __setLocaleLoaderForTest("ko", () => Promise.reject(new Error("missing chunk")));

    try {
      setLocale("en");

      await expect(applyBootLocale(settingsService)).resolves.toBeUndefined();

      expect(getLocale()).toBe("en");
      expect(translate("en", "settings.appearance.language.title")).toBe("Language");
    } finally {
      restore();
    }
  });
});
