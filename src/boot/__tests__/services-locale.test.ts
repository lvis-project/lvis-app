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

const originalArgv = process.argv;

afterEach(() => {
  process.argv = originalArgv;
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

  it("ignores the persisted locale on a headless run so the request decides the language", async () => {
    // The setting names the language the app's surfaces are drawn in, and a
    // one-shot run draws none. What it does have is a system prompt assembled
    // through the same catalog: under a non-English setting the model was
    // handed a prompt in the machine's language and answered in it.
    // The stub throws rather than answering: a headless run must not consult
    // the persisted language at all, so reading it is itself the failure.
    const settingsService = {
      get: () => { throw new Error("headless boot read the persisted locale"); },
    } as unknown as Parameters<typeof applyBootLocale>[0];
    process.argv = ["electron", ".", "--exec", "do the task"];
    setLocale("ko");

    await applyBootLocale(settingsService);

    expect(getLocale()).toBe(DEFAULT_LOCALE);
  });
});
