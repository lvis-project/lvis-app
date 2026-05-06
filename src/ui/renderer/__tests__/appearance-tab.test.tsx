/**
 * UX Track 3 — AppearanceTab tests (two-axis redesign).
 *
 * The tab is a stack of three radio groups:
 *  1. 채팅 테마 (chat accent — 4 visual cards)
 *  2. 코드 테마 (code surface — 2 visual cards)
 *  3. 앱 라이트/다크 (shell — 4 pill buttons)
 *
 * Cards/pills are <button role="radio">; we drive them with click events
 * and assert against the document data-attributes that ThemeProvider writes.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-chat-theme");
  document.documentElement.removeAttribute("data-code-theme");
  vi.unstubAllGlobals();
});

function renderWithTheme(initial: "system" | "light" | "dark" | "high-contrast" = "dark") {
  return render(
    <ThemeProvider initialPreference={initial}>
      <AppearanceTab />
    </ThemeProvider>,
  );
}

describe("AppearanceTab — chat-theme picker", () => {
  it("renders one card per chat-theme variant", () => {
    const { getByRole } = renderWithTheme();
    expect(getByRole("radio", { name: /채팅 테마: 기본/ })).toBeTruthy();
    expect(getByRole("radio", { name: /채팅 테마: LG/ })).toBeTruthy();
    expect(getByRole("radio", { name: /채팅 테마: 퍼플/ })).toBeTruthy();
    expect(getByRole("radio", { name: /채팅 테마: 오렌지/ })).toBeTruthy();
    expect(getByRole("radio", { name: /채팅 테마: 블루/ })).toBeTruthy();
  });

  it("clicking LG writes data-chat-theme=lg to <html>", async () => {
    const { getByRole } = renderWithTheme("dark");
    // First switch away from the LG default, then back.
    fireEvent.click(getByRole("radio", { name: /채팅 테마: 퍼플/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
    });
    fireEvent.click(getByRole("radio", { name: /채팅 테마: LG/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("lg");
    });
  });

  it("clicking 퍼플 writes data-chat-theme=purple to <html>", async () => {
    const { getByRole } = renderWithTheme("dark");
    fireEvent.click(getByRole("radio", { name: /채팅 테마: 퍼플/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
    });
  });

  it("clicking 기본 removes data-chat-theme (no override)", async () => {
    const { getByRole } = renderWithTheme("dark");
    // The provider defaults to chatTheme="lg" so the data-chat-theme
    // attribute is already set on mount; "기본" must clear it.
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("lg");
    });
    fireEvent.click(getByRole("radio", { name: /채팅 테마: 기본/ }));
    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-chat-theme")).toBe(false);
    });
  });

  it("selected card receives aria-checked=true", async () => {
    const { getByRole } = renderWithTheme("dark");
    fireEvent.click(getByRole("radio", { name: /채팅 테마: 오렌지/ }));
    await waitFor(() => {
      expect(getByRole("radio", { name: /채팅 테마: 오렌지/ }).getAttribute("aria-checked")).toBe("true");
      expect(getByRole("radio", { name: /채팅 테마: 기본/ }).getAttribute("aria-checked")).toBe("false");
    });
  });
});

describe("AppearanceTab — code-theme picker", () => {
  it("renders one card per code-theme variant", () => {
    const { getByRole } = renderWithTheme();
    expect(getByRole("radio", { name: /코드 테마: 라이트/ })).toBeTruthy();
    expect(getByRole("radio", { name: /코드 테마: 다크/ })).toBeTruthy();
  });

  it("clicking 라이트 writes data-code-theme=light", async () => {
    const { getByRole } = renderWithTheme("dark");
    fireEvent.click(getByRole("radio", { name: /코드 테마: 라이트/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-code-theme")).toBe("light");
    });
  });

  it("on dark shell with auto codeTheme, the dark card is the implicitly selected one", () => {
    const { getByRole } = renderWithTheme("dark");
    // codeTheme starts as "auto"; on dark shell, resolvedCodeTheme === "dark"
    expect(getByRole("radio", { name: /코드 테마: 다크/ }).getAttribute("aria-checked")).toBe("true");
    expect(getByRole("radio", { name: /코드 테마: 라이트/ }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("AppearanceTab — shell picker", () => {
  it("renders all four shell options as pill radios", () => {
    const { getByRole } = renderWithTheme();
    expect(getByRole("radio", { name: /^시스템$/ })).toBeTruthy();
    expect(getByRole("radio", { name: /^라이트$/ })).toBeTruthy();
    expect(getByRole("radio", { name: /^다크$/ })).toBeTruthy();
    expect(getByRole("radio", { name: /^고대비$/ })).toBeTruthy();
  });

  it("clicking 라이트 writes data-theme=light", async () => {
    const { getByRole } = renderWithTheme("dark");
    fireEvent.click(getByRole("radio", { name: /^라이트$/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  it("shows the resolved shell theme in the disclosure caption", async () => {
    const { getAllByText } = renderWithTheme("dark");
    await waitFor(() => {
      expect(getAllByText(/현재:/).some((el) => el.textContent === "현재: dark")).toBe(true);
    });
  });

  it("indicates system when the user picked system", () => {
    const { getByText } = renderWithTheme("system");
    expect(getByText(/시스템 설정 기반/)).toBeTruthy();
  });
});
