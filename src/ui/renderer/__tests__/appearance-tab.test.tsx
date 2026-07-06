/**
 * AppearanceTab v2 — bundle picker tests.
 *
 * The tab shows one bundle card per ThemeBundle in a single grid.
 * Clicking a card sets the active bundle and writes data-theme-bundle to <html>.
 *
 * followSystem toggle is shown only when the violet pair (violet-light / violet-dark)
 * is selected; hidden otherwise.
 *
 * The external URL (webView) section is unchanged from v1.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import {
  DEFAULT_BUNDLE_ID,
  DEFAULT_VISIBLE_BUNDLES,
} from "../theme/index.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  Array.from(document.documentElement.classList)
    .filter((c) => c.startsWith("lvis-bundle-"))
    .forEach((c) => document.documentElement.classList.remove(c));
  delete (window as unknown as Record<string, unknown>).lvisApi;
  vi.unstubAllGlobals();
});

function renderWithBundle(initialBundleId = DEFAULT_BUNDLE_ID, onOpenMarketplace?: (filter: "theme" | "language-pack") => void) {
  return render(
    <ThemeProvider initialBundleId={initialBundleId}>
      <AppearanceTab onOpenMarketplace={onOpenMarketplace} />
    </ThemeProvider>,
  );
}

describe("AppearanceTab — bundle card grid", () => {
  it("renders exactly one card per default visible ThemeBundle", () => {
    const { getAllByRole } = renderWithBundle();
    // All cards have role="radio" with aria-label "테마: <name>"
    const cards = getAllByRole("radio").filter((el) =>
      el.getAttribute("aria-label")?.startsWith("테마:"),
    );
    expect(cards).toHaveLength(DEFAULT_VISIBLE_BUNDLES.length);
  });

  it("renders a card for each default visible bundle", () => {
    const { getByRole, queryByRole } = renderWithBundle();
    for (const bundle of DEFAULT_VISIBLE_BUNDLES) {
      expect(getByRole("radio", { name: `테마: ${bundle.name}` })).toBeTruthy();
    }
    expect(queryByRole("radio", { name: /테마: Forest/ })).toBeNull();
  });

  it("the default bundle card has aria-checked=true", () => {
    const { getByRole } = renderWithBundle();
    const card = getByRole("radio", { name: /테마: Moonstone/ });
    expect(card.getAttribute("aria-checked")).toBe("true");
  });

  it("other cards have aria-checked=false initially", () => {
    const { getByRole } = renderWithBundle();
    const gallery = getByRole("radio", { name: /테마: Gallery/ });
    expect(gallery.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a bundle card writes data-theme-bundle to <html>", async () => {
    const { getByRole } = renderWithBundle();
    fireEvent.click(getByRole("radio", { name: /테마: Gallery/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("gallery");
    });
  });

  it("keeps a selected marketplace-candidate theme in the picker", () => {
    const { getByRole, queryByRole } = renderWithBundle("violet-dark");
    const selected = getByRole("radio", { name: /테마: Violet Dark/ });
    expect(selected.getAttribute("aria-checked")).toBe("true");
    expect(queryByRole("radio", { name: /테마: Forest/ })).toBeNull();
  });

  it("shows marketplace-installed themes and language packs", async () => {
    const { api } = makeMockLvisApi({
      settings: {
        marketplace: {
          installedThemeBundleIds: ["tokyo-night"],
          installedLanguagePacks: ["ko"],
        },
      },
    });
    (window as unknown as { lvisApi: unknown }).lvisApi = api;

    const { getByRole, getByTestId } = renderWithBundle();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

    expect(getByRole("radio", { name: /테마: Tokyo Night/ })).toBeTruthy();
    expect(getByTestId("language-option-ko")).toBeTruthy();
    expect(getByTestId("appearance-tab:theme-marketplace-badge:tokyo-night"))
      .toHaveTextContent("마켓플레이스");
    expect(getByTestId("language-option-ko"))
      .toHaveAttribute("data-marketplace-installed", "true");
    expect(getByTestId("appearance-tab:language-marketplace-badge:ko"))
      .toHaveTextContent("마켓플레이스");
  });

  it("reflects theme and language packages installed after a Marketplace settings broadcast", async () => {
    const { api } = makeMockLvisApi();
    (window as unknown as { lvisApi: unknown }).lvisApi = api;

    const { getByRole, getByTestId, queryByRole } = renderWithBundle();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    expect(queryByRole("radio", { name: /테마: Tokyo Night/ })).toBeNull();

    await act(async () => {
      await api.updateSettings({
        marketplace: {
          installedThemeBundleIds: ["tokyo-night"],
          installedLanguagePacks: ["ko"],
        },
      });
    });

    await waitFor(() => {
      expect(getByRole("radio", { name: /테마: Tokyo Night/ })).toBeTruthy();
      expect(getByTestId("language-option-ko")).toBeTruthy();
    });
    expect(getByTestId("appearance-tab:theme-marketplace-badge:tokyo-night"))
      .toHaveTextContent("마켓플레이스");
    expect(getByTestId("appearance-tab:language-marketplace-badge:ko"))
      .toHaveTextContent("마켓플레이스");
  });


  it("opens Marketplace filters from theme and language CTAs", () => {
    const onOpenMarketplace = vi.fn();
    const { getByTestId } = renderWithBundle(DEFAULT_BUNDLE_ID, onOpenMarketplace);

    fireEvent.click(getByTestId("appearance-tab:marketplace-languages"));
    expect(onOpenMarketplace).toHaveBeenLastCalledWith("language-pack");

    fireEvent.click(getByTestId("appearance-tab:marketplace-themes"));
    expect(onOpenMarketplace).toHaveBeenLastCalledWith("theme");
  });

  it("recommends the matching system language pack without installing it", async () => {
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "ja-JP",
    });
    const onOpenMarketplace = vi.fn();
    try {
      const { api } = makeMockLvisApi();
      (window as unknown as { lvisApi: unknown }).lvisApi = api;

      const { getByTestId, queryByTestId } = renderWithBundle(DEFAULT_BUNDLE_ID, onOpenMarketplace);
      await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

      expect(queryByTestId("language-option-ja")).toBeNull();
      expect(getByTestId("appearance-tab:language-recommendation"))
        .toHaveTextContent("Japanese 언어 팩이 시스템 언어와 일치합니다.");
      fireEvent.click(getByTestId("appearance-tab:language-recommendation-open:ja"));
      expect(onOpenMarketplace).toHaveBeenCalledWith("language-pack");
    } finally {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        value: originalLanguage,
      });
    }
  });

  it("clicking back to a default theme writes data-theme-bundle=gallery", async () => {
    const { getByRole } = renderWithBundle("violet-dark");
    fireEvent.click(getByRole("radio", { name: /테마: Gallery/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("gallery");
    });
  });

  it("keeps high-contrast visible only when it is the selected legacy theme", () => {
    const { getByRole } = renderWithBundle("high-contrast");
    expect(getByRole("radio", { name: /테마: High Contrast/ }).getAttribute("aria-checked")).toBe("true");
  });

  it("selected card updates aria-checked after click", async () => {
    const { getByRole, queryByRole } = renderWithBundle("tokyo-night");
    const gallery = getByRole("radio", { name: /테마: Gallery/ });
    fireEvent.click(gallery);
    await waitFor(() => {
      expect(gallery.getAttribute("aria-checked")).toBe("true");
    });
    expect(queryByRole("radio", { name: /테마: Tokyo Night/ })).toBeNull();
  });
});

describe("AppearanceTab — followSystem toggle (violet pair only)", () => {
  it("followSystem toggle is hidden when a non-violet bundle is active", () => {
    const { queryByTestId } = renderWithBundle("tokyo-night");
    expect(queryByTestId("follow-system-toggle")).toBeNull();
  });

  it("followSystem toggle is shown when violet-light is active", async () => {
    const { getByTestId } = renderWithBundle("violet-light");
    await waitFor(() => {
      expect(getByTestId("follow-system-toggle")).toBeTruthy();
    });
  });

  it("followSystem toggle is shown when violet-dark is active", async () => {
    const { getByTestId } = renderWithBundle("violet-dark");
    // Already on violet-dark — toggle should be visible
    await waitFor(() => {
      expect(getByTestId("follow-system-toggle")).toBeTruthy();
    });
  });

  it("high-contrast card has no followSystem toggle", async () => {
    const { queryByTestId } = renderWithBundle("high-contrast");
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("high-contrast");
    });
    expect(queryByTestId("follow-system-toggle")).toBeNull();
  });
});

describe("AppearanceTab — webView preferredFlow section", () => {
  it("renders in-app and system-browser radio options", () => {
    const { getByTestId } = renderWithBundle();
    const group = getByTestId("webview-preferred-flow");
    expect(group).toBeTruthy();
    expect(group.querySelector('[data-value="in-app"]')).toBeTruthy();
    expect(group.querySelector('[data-value="system-browser"]')).toBeTruthy();
  });
});
