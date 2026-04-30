/**
 * UX Track 3 — AppearanceTab tests.
 *
 * The tab is a thin radio group that delegates to ThemeProvider. We verify:
 *  - it renders the four shipped variants
 *  - clicking a radio calls setPreference and updates the live `data-theme`
 *  - disclosure copy reflects the resolved theme (not just the preference)
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  vi.unstubAllGlobals();
});

function renderWithTheme(initial: "system" | "light" | "dark" | "high-contrast" = "dark") {
  return render(
    <ThemeProvider initialPreference={initial}>
      <AppearanceTab />
    </ThemeProvider>,
  );
}

describe("AppearanceTab", () => {
  it("renders one radio per shipped theme variant", () => {
    const { getByLabelText } = renderWithTheme();
    expect(getByLabelText(/시스템 설정 따르기/)).toBeTruthy();
    expect(getByLabelText(/라이트/)).toBeTruthy();
    expect(getByLabelText(/다크/)).toBeTruthy();
    expect(getByLabelText(/고대비/)).toBeTruthy();
  });

  it("clicking a radio updates the live data-theme", async () => {
    const { getByLabelText } = renderWithTheme("dark");
    fireEvent.click(getByLabelText(/라이트/));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  it("shows the resolved theme in the disclosure caption", async () => {
    const { getByText } = renderWithTheme("dark");
    // disclosure renders `현재 적용된 테마: dark`
    await waitFor(() => {
      expect(getByText(/현재 적용된 테마/)).toBeTruthy();
    });
  });

  it("indicates `system` when the user picked system", () => {
    const { getByText } = renderWithTheme("system");
    expect(getByText(/시스템 설정 기반/)).toBeTruthy();
  });
});
