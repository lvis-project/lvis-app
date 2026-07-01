// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { useTranslation } from "../../../../i18n/react.js";
import type { Locale } from "../../../../i18n/locale.js";
import { __setLocaleLoaderForTest } from "../../../../i18n/messages/index.js";
import { I18nSettingsProvider } from "../i18n-settings-provider.js";

function installApi(initialLanguage: Locale = "en") {
  const settingsUpdatedHandlers: Array<(settings: { appearance?: { language?: Locale } }) => void> = [];
  const api = {
    getSettings: vi.fn(async () => ({ appearance: { language: initialLanguage } })),
    updateSettings: vi.fn(async () => ({})),
    onSettingsUpdated: vi.fn((handler: (settings: { appearance?: { language?: Locale } }) => void) => {
      settingsUpdatedHandlers.push(handler);
      return () => undefined;
    }),
  };
  (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
  return { api, settingsUpdatedHandlers };
}

function LocaleProbe() {
  const { locale, setLocale, t } = useTranslation();
  return (
    <div>
      <span data-testid="active-locale">{locale}</span>
      <span data-testid="language-title">{t("settings.appearance.language.title")}</span>
      <button type="button" onClick={() => setLocale("zh")}>zh</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { lvisApi?: unknown }).lvisApi;
});

describe("I18nSettingsProvider lazy locale loading", () => {
  it("hydrates a persisted lazy locale before switching the rendered catalog", async () => {
    installApi("ja");

    render(
      <I18nSettingsProvider>
        <LocaleProbe />
      </I18nSettingsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ja");
      expect(screen.getByTestId("language-title")).toHaveTextContent("言語");
    });
  });

  it("loads the selected locale catalog before applying a user language switch", async () => {
    const { api } = installApi("en");

    render(
      <I18nSettingsProvider>
        <LocaleProbe />
      </I18nSettingsProvider>,
    );

    expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

    fireEvent.click(screen.getByText("zh"));

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("zh");
      expect(screen.getByTestId("language-title")).toHaveTextContent("语言");
    });
    expect(api.updateSettings).toHaveBeenCalledWith({
      appearance: { schemaVersion: 2, language: "zh" },
    });
  });

  it("loads a lazy locale received from cross-window settings sync", async () => {
    const { settingsUpdatedHandlers } = installApi("en");

    render(
      <I18nSettingsProvider>
        <LocaleProbe />
      </I18nSettingsProvider>,
    );

    expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

    settingsUpdatedHandlers[0]?.({ appearance: { language: "ja" } });

    await waitFor(() => {
      expect(screen.getByTestId("active-locale")).toHaveTextContent("ja");
      expect(screen.getByTestId("language-title")).toHaveTextContent("言語");
    });
  });

  it("keeps the current rendered locale when a selected lazy catalog fails to load", async () => {
    const { api } = installApi("en");
    const restore = __setLocaleLoaderForTest("zh", () => Promise.reject(new Error("missing chunk")));

    try {
      render(
        <I18nSettingsProvider>
          <LocaleProbe />
        </I18nSettingsProvider>,
      );

      expect(screen.getByTestId("language-title")).toHaveTextContent("Language");

      fireEvent.click(screen.getByText("zh"));

      await waitFor(() => {
        expect(api.updateSettings).toHaveBeenCalledWith({
          appearance: { schemaVersion: 2, language: "zh" },
        });
      });
      expect(screen.getByTestId("active-locale")).toHaveTextContent("en");
      expect(screen.getByTestId("language-title")).toHaveTextContent("Language");
    } finally {
      restore();
    }
  });
});
