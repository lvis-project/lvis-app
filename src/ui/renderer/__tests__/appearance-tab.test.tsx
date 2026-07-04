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
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { BUNDLES, DEFAULT_BUNDLE_ID } from "../theme/index.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  Array.from(document.documentElement.classList)
    .filter((c) => c.startsWith("lvis-bundle-"))
    .forEach((c) => document.documentElement.classList.remove(c));
  vi.unstubAllGlobals();
});

function renderWithBundle(initialBundleId = DEFAULT_BUNDLE_ID) {
  return render(
    <ThemeProvider initialBundleId={initialBundleId}>
      <AppearanceTab />
    </ThemeProvider>,
  );
}

describe("AppearanceTab — bundle card grid", () => {
  it("renders exactly one card per ThemeBundle", () => {
    const { getAllByRole } = renderWithBundle();
    // All cards have role="radio" with aria-label "테마: <name>"
    const cards = getAllByRole("radio").filter((el) =>
      el.getAttribute("aria-label")?.startsWith("테마:"),
    );
    expect(cards).toHaveLength(BUNDLES.length);
  });

  it("renders a card for each bundle in BUNDLES", () => {
    const { getByRole } = renderWithBundle();
    for (const bundle of BUNDLES) {
      expect(getByRole("radio", { name: `테마: ${bundle.name}` })).toBeTruthy();
    }
  });

  it("the default bundle card has aria-checked=true", () => {
    const { getByRole } = renderWithBundle();
    const card = getByRole("radio", { name: /테마: Moonstone/ });
    expect(card.getAttribute("aria-checked")).toBe("true");
  });

  it("other cards have aria-checked=false initially", () => {
    const { getByRole } = renderWithBundle("tokyo-night");
    const forest = getByRole("radio", { name: /테마: Forest/ });
    expect(forest.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a bundle card writes data-theme-bundle to <html>", async () => {
    const { getByRole } = renderWithBundle("tokyo-night");
    fireEvent.click(getByRole("radio", { name: /테마: Forest/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("forest");
    });
  });

  it("clicking violet-dark card writes data-theme-bundle=violet-dark", async () => {
    const { getByRole } = renderWithBundle("tokyo-night");
    fireEvent.click(getByRole("radio", { name: /테마: Violet Dark/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("violet-dark");
    });
  });

  it("clicking high-contrast card writes data-theme-bundle=high-contrast", async () => {
    const { getByRole } = renderWithBundle("tokyo-night");
    fireEvent.click(getByRole("radio", { name: /테마: High Contrast/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("high-contrast");
    });
  });

  it("selected card updates aria-checked after click", async () => {
    const { getByRole } = renderWithBundle("tokyo-night");
    const forest = getByRole("radio", { name: /테마: Forest/ });
    fireEvent.click(forest);
    await waitFor(() => {
      expect(forest.getAttribute("aria-checked")).toBe("true");
    });
    expect(getByRole("radio", { name: /테마: Tokyo Night/ }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("AppearanceTab — followSystem toggle (violet pair only)", () => {
  it("followSystem toggle is hidden when a non-violet bundle is active", () => {
    const { queryByTestId } = renderWithBundle("tokyo-night");
    expect(queryByTestId("follow-system-toggle")).toBeNull();
  });

  it("followSystem toggle is shown when violet-light is active", async () => {
    const { getByRole, getByTestId } = renderWithBundle("tokyo-night");
    fireEvent.click(getByRole("radio", { name: /테마: Violet Light/ }));
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
    const { getByRole, queryByTestId } = renderWithBundle("tokyo-night");
    fireEvent.click(getByRole("radio", { name: /테마: High Contrast/ }));
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
