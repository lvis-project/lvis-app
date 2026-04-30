/**
 * UX Track 3 — AppearanceTab tests.
 *
 * The tab is a thin radio group that delegates to ThemeProvider. We verify:
 *  - it renders the four shipped variants
 *  - clicking a radio calls setPreference and updates the live `data-theme`
 *  - disclosure copy reflects the resolved theme (not just the preference)
 *
 * NOTE: uses getByRole('radio', { name }) instead of getByLabelText because
 * the system-hint text contains "라이트/다크" which would cause regex /라이트/
 * to match two elements (the hint paragraph + the radio label).
 * getByRole computes the accessible name from the wrapping <label> text node,
 * so it resolves to a single, unambiguous element.
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
    const { getByRole } = renderWithTheme();
    // exact accessible names from the <label> text content
    expect(getByRole("radio", { name: /시스템 설정 따르기/ })).toBeTruthy();
    expect(getByRole("radio", { name: /^라이트/ })).toBeTruthy();
    expect(getByRole("radio", { name: /^다크/ })).toBeTruthy();
    expect(getByRole("radio", { name: /고대비/ })).toBeTruthy();
  });

  it("clicking the 라이트 radio updates the live data-theme", async () => {
    const { getByRole } = renderWithTheme("dark");
    fireEvent.click(getByRole("radio", { name: /^라이트/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  it("shows the resolved theme in the disclosure caption", async () => {
    const { getByText } = renderWithTheme("dark");
    await waitFor(() => {
      expect(getByText(/현재 적용된 테마/)).toBeTruthy();
    });
  });

  it("indicates system when the user picked system", () => {
    const { getByText } = renderWithTheme("system");
    expect(getByText(/시스템 설정 기반/)).toBeTruthy();
  });
});
