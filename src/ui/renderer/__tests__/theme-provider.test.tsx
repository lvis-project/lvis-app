/**
 * UX Track 3 — ThemeProvider unit tests.
 *
 * Covers:
 *  - resolveTheme() pure function (system → light/dark fallback)
 *  - applyThemeToDocument() writes data-theme + class
 *  - <ThemeProvider> hydrates from settings
 *  - setPreference() persists through api.updateSettings()
 *  - Persistence roundtrip: set dark → simulate reload → still dark
 *  - reduced-motion: no transition declared on <html> when media matches
 *  - useTheme outside provider throws (programmer-error guard)
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ThemeProvider, useTheme, useOptionalTheme } from "../theme/ThemeProvider.js";
import { applyThemeToDocument, resolveTheme } from "../theme/resolve-theme.js";
import { THEME_PREFERENCES } from "../theme/types.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.classList.remove(
    "lvis-theme-light",
    "lvis-theme-dark",
    "lvis-theme-high-contrast",
  );
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("returns explicit value as-is for non-system preferences", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("high-contrast")).toBe("high-contrast");
  });

  it("system → light when prefers-color-scheme: light matches", () => {
    const win = { matchMedia: () => ({ matches: true } as MediaQueryList) } as unknown as Window;
    expect(resolveTheme("system", win)).toBe("light");
  });

  it("system → dark when prefers-color-scheme: light does not match", () => {
    const win = { matchMedia: () => ({ matches: false } as MediaQueryList) } as unknown as Window;
    expect(resolveTheme("system", win)).toBe("dark");
  });

  it("system → dark fallback when matchMedia is unavailable", () => {
    expect(resolveTheme("system", undefined)).toBe("dark");
  });
});

describe("applyThemeToDocument", () => {
  it("writes data-theme attribute and theme class", () => {
    applyThemeToDocument("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.classList.contains("lvis-theme-light")).toBe(true);
  });

  it("removes prior theme class when switching", () => {
    applyThemeToDocument("dark");
    applyThemeToDocument("light");
    expect(document.documentElement.classList.contains("lvis-theme-dark")).toBe(false);
    expect(document.documentElement.classList.contains("lvis-theme-light")).toBe(true);
  });
});

describe("THEME_PREFERENCES", () => {
  it("includes the four shipped variants", () => {
    expect([...THEME_PREFERENCES]).toEqual(["system", "light", "dark", "high-contrast"]);
  });
});

describe("<ThemeProvider>", () => {
  function Probe({ onValue }: { onValue: (v: ReturnType<typeof useTheme>) => void }) {
    const v = useTheme();
    useEffect(() => { onValue(v); }, [v, onValue]);
    return null;
  }

  it("hydrates from api.getSettings() on mount", async () => {
    const { api } = makeMockLvisApi({
      settings: {
        llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        appearance: { theme: "light" },
      },
    });
    const seen: string[] = [];
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => seen.push(v.preference)} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(seen).toContain("light");
    });
    expect(api.getSettings).toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("falls back to default when settings load fails", async () => {
    const { api } = makeMockLvisApi();
    api.getSettings.mockRejectedValueOnce(new Error("boom"));
    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.preference; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).not.toBeNull();
    });
    // initial preference falls through to "system"
    expect(observed).toBe("system");
  });

  it("setPreference persists via api.updateSettings and updates DOM", async () => {
    const { api } = makeMockLvisApi();
    let setter: ((v: "light" | "dark" | "system" | "high-contrast") => void) | null = null;
    function Capture() {
      const { setPreference } = useTheme();
      setter = setPreference;
      return null;
    }
    render(
      <ThemeProvider api={api as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(setter).not.toBeNull();
    });
    act(() => { setter!("dark"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { theme: "dark" } });
  });

  it("persistence roundtrip: set dark → simulated reload → still dark", async () => {
    // First mount: user picks dark.
    let stored: { theme: "system" | "light" | "dark" | "high-contrast" } = { theme: "system" };
    const settingsBacking = {
      llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
      chat: { systemPrompt: "", autoCompact: true },
      webSearch: { provider: "none" },
      appearance: stored,
    };
    const { api: api1 } = makeMockLvisApi({ settings: settingsBacking });
    api1.updateSettings.mockImplementation(async (patch: any) => {
      if (patch.appearance) stored = { ...stored, ...patch.appearance };
      return { ...settingsBacking, appearance: stored };
    });
    let setter: ((v: "light" | "dark" | "system" | "high-contrast") => void) | null = null;
    function Capture() {
      const { setPreference } = useTheme();
      setter = setPreference;
      return null;
    }
    const first = render(
      <ThemeProvider api={api1 as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("dark"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
    expect(stored.theme).toBe("dark");
    first.unmount();

    // Second mount: a fresh provider with backing storage that remembers the
    // prior write — same lifecycle the user experiences after a real app
    // reload.
    const { api: api2 } = makeMockLvisApi({
      settings: { ...settingsBacking, appearance: stored },
    });
    let observed: string | null = null;
    render(
      <ThemeProvider api={api2 as never}>
        <Probe onValue={(v) => { observed = v.preference; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("dark");
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("uses initialPreference when no api is provided", () => {
    let observed: string | null = null;
    render(
      <ThemeProvider initialPreference="high-contrast">
        <Probe onValue={(v) => { observed = v.preference; }} />
      </ThemeProvider>,
    );
    expect(observed).toBe("high-contrast");
    expect(document.documentElement.getAttribute("data-theme")).toBe("high-contrast");
  });

  it("useTheme throws when called outside the provider", () => {
    function BadConsumer() {
      useTheme();
      return null;
    }
    // @testing-library logs the React error boundary message; mute it.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<BadConsumer />)).toThrow(/ThemeProvider/);
    errSpy.mockRestore();
  });

  it("useOptionalTheme returns null without a provider (escape hatch)", () => {
    let observed: unknown = "untouched";
    function OptConsumer() {
      observed = useOptionalTheme();
      return null;
    }
    render(<OptConsumer />);
    expect(observed).toBeNull();
  });
});

describe("<ThemeProvider> + reduced-motion", () => {
  beforeEach(() => {
    // Stub matchMedia to return matches=true for prefers-reduced-motion.
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  it("does not throw and applies theme cleanly when reduced-motion is set", () => {
    render(
      <ThemeProvider initialPreference="dark">
        <div />
      </ThemeProvider>,
    );
    // The transition itself is declared in styles.css and gated by
    // @media (prefers-reduced-motion: reduce). The runtime contract we
    // verify here is that the provider never injects an inline transition
    // that would defeat that media query.
    const inline = document.documentElement.getAttribute("style") ?? "";
    expect(inline).not.toMatch(/transition/i);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
