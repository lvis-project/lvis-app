/**
 * UX Track 3 — ThemeProvider unit tests (two-axis redesign).
 *
 * Covers:
 *  - resolveTheme() pure function (system → light/dark fallback)
 *  - resolveCodeTheme() pure function (auto follows shell)
 *  - applyThemeToDocument() writes data-theme + class
 *  - applyChatThemeToDocument() writes/removes data-chat-theme
 *  - applyCodeThemeToDocument() writes data-code-theme
 *  - <ThemeProvider> hydrates all three axes from settings
 *  - setPreference / setChatTheme / setCodeTheme persist via api.updateSettings()
 *  - Persistence roundtrip: set chat=purple → simulate reload → still purple
 *  - reduced-motion: no transition declared on <html> when media matches
 *  - useTheme outside provider throws (programmer-error guard)
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ThemeProvider, useTheme, useOptionalTheme, resolvePluginTokens } from "../theme/ThemeProvider.js";
import {
  applyChatThemeToDocument,
  applyCodeThemeToDocument,
  applyThemeToDocument,
  resolveCodeTheme,
  resolveTheme,
} from "../theme/resolve-theme.js";
import {
  CHAT_THEME_PREFERENCES,
  CODE_THEME_PREFERENCES,
  THEME_PREFERENCES,
} from "../theme/types.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-chat-theme");
  document.documentElement.removeAttribute("data-code-theme");
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

describe("CHAT_THEME_PREFERENCES", () => {
  it("includes the chat accent variants and the LG brand identity", () => {
    expect([...CHAT_THEME_PREFERENCES]).toEqual(["default", "lg", "purple", "orange", "blue"]);
  });
});

describe("CODE_THEME_PREFERENCES", () => {
  it("includes auto + the two explicit code variants", () => {
    expect([...CODE_THEME_PREFERENCES]).toEqual(["auto", "light", "dark"]);
  });
});

describe("resolveCodeTheme", () => {
  it("returns explicit value when not auto", () => {
    expect(resolveCodeTheme("light", "dark")).toBe("light");
    expect(resolveCodeTheme("dark", "light")).toBe("dark");
  });

  it("auto follows the resolved shell — light shell → light code", () => {
    expect(resolveCodeTheme("auto", "light")).toBe("light");
  });

  it("auto follows the resolved shell — dark shell → dark code", () => {
    expect(resolveCodeTheme("auto", "dark")).toBe("dark");
  });

  it("auto pairs high-contrast with dark code", () => {
    expect(resolveCodeTheme("auto", "high-contrast")).toBe("dark");
  });
});

describe("applyChatThemeToDocument", () => {
  it("writes data-chat-theme for non-default values", () => {
    applyChatThemeToDocument("purple");
    expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
  });

  it("removes data-chat-theme for default (no override)", () => {
    document.documentElement.setAttribute("data-chat-theme", "purple");
    applyChatThemeToDocument("default");
    expect(document.documentElement.hasAttribute("data-chat-theme")).toBe(false);
  });
});

describe("applyCodeThemeToDocument", () => {
  it("writes data-code-theme attribute", () => {
    applyCodeThemeToDocument("light");
    expect(document.documentElement.getAttribute("data-code-theme")).toBe("light");
    applyCodeThemeToDocument("dark");
    expect(document.documentElement.getAttribute("data-code-theme")).toBe("dark");
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

  it("setChatTheme writes data-chat-theme + persists via api.updateSettings", async () => {
    const { api } = makeMockLvisApi();
    let setter: ((v: "default" | "lg" | "purple" | "orange" | "blue") => void) | null = null;
    function Capture() {
      const { setChatTheme } = useTheme();
      setter = setChatTheme;
      return null;
    }
    render(
      <ThemeProvider api={api as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("purple"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
    });
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { chatTheme: "purple" } });
  });

  it("setChatTheme=default removes data-chat-theme attribute", async () => {
    // Note: `initialChatTheme="purple"` alone is not enough — ThemeProvider's
    // settings-hydration effect will resolve `api.getSettings()` and overwrite
    // the initial state with whatever the mock returns (default → "default").
    // The test must therefore either wait for hydration to finish, or feed
    // the mock a settings shape whose `appearance.chatTheme` agrees with the
    // initial value. We do the latter so the assertion is deterministic and
    // unaffected by future shifts in effect ordering.
    const { api } = makeMockLvisApi({
      settings: { appearance: { chatTheme: "purple" } } as never,
    });
    let setter: ((v: "default" | "lg" | "purple" | "orange" | "blue") => void) | null = null;
    function Capture() {
      const { setChatTheme } = useTheme();
      setter = setChatTheme;
      return null;
    }
    render(
      <ThemeProvider api={api as never} initialChatTheme="purple">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    // Wait for the chat-theme effect to flush. Without this, the assertion
    // races against React's effect scheduler and flakes on slow CI.
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
    });
    act(() => { setter!("default"); });
    await waitFor(() => {
      expect(document.documentElement.hasAttribute("data-chat-theme")).toBe(false);
    });
  });

  it("setCodeTheme writes data-code-theme + persists via api.updateSettings", async () => {
    const { api } = makeMockLvisApi();
    let setter: ((v: "auto" | "light" | "dark") => void) | null = null;
    function Capture() {
      const { setCodeTheme } = useTheme();
      setter = setCodeTheme;
      return null;
    }
    render(
      <ThemeProvider api={api as never} initialPreference="dark">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("light"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-code-theme")).toBe("light");
    });
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { codeTheme: "light" } });
  });

  it("auto codeTheme tracks shell — switching shell light↔dark updates data-code-theme", async () => {
    let setter: ((v: "system" | "light" | "dark" | "high-contrast") => void) | null = null;
    function Capture() {
      const { setPreference } = useTheme();
      setter = setPreference;
      return null;
    }
    render(
      <ThemeProvider initialPreference="dark" initialCodeTheme="auto">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    expect(document.documentElement.getAttribute("data-code-theme")).toBe("dark");
    act(() => { setter!("light"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-code-theme")).toBe("light");
    });
  });

  it("hydrates chatTheme + codeTheme from settings on mount", async () => {
    const { api } = makeMockLvisApi({
      settings: {
        llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        appearance: { theme: "dark", chatTheme: "orange", codeTheme: "light" },
      },
    });
    let observed: { chatTheme: string; codeTheme: string } | null = null;
    function Probe() {
      const { chatTheme, codeTheme } = useTheme();
      useEffect(() => { observed = { chatTheme, codeTheme }; }, [chatTheme, codeTheme]);
      return null;
    }
    render(
      <ThemeProvider api={api as never}>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed?.chatTheme).toBe("orange");
      expect(observed?.codeTheme).toBe("light");
    });
    expect(document.documentElement.getAttribute("data-chat-theme")).toBe("orange");
    expect(document.documentElement.getAttribute("data-code-theme")).toBe("light");
  });

  it("persistence roundtrip for chatTheme: set purple → simulated reload → still purple", async () => {
    let stored: { theme: "system" | "light" | "dark" | "high-contrast"; chatTheme?: string; codeTheme?: string } = {
      theme: "system",
      chatTheme: "default",
      codeTheme: "auto",
    };
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
    let setter: ((v: "default" | "lg" | "purple" | "orange" | "blue") => void) | null = null;
    function Capture() {
      const { setChatTheme } = useTheme();
      setter = setChatTheme;
      return null;
    }
    const first = render(
      <ThemeProvider api={api1 as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("purple"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
    });
    expect(stored.chatTheme).toBe("purple");
    first.unmount();

    const { api: api2 } = makeMockLvisApi({
      settings: { ...settingsBacking, appearance: stored },
    });
    let observed: string | null = null;
    function ObserveChat() {
      const { chatTheme } = useTheme();
      useEffect(() => { observed = chatTheme; }, [chatTheme]);
      return null;
    }
    render(
      <ThemeProvider api={api2 as never}>
        <ObserveChat />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("purple");
    });
    expect(document.documentElement.getAttribute("data-chat-theme")).toBe("purple");
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

describe("resolvePluginTokens", () => {
  it("dark/default — returns all 17 --lvis-* keys", () => {
    const tokens = resolvePluginTokens("dark", "default");
    expect(Object.keys(tokens)).toHaveLength(17);
    expect(tokens["--lvis-bg"]).toMatch(/^hsl\(/);
    expect(tokens["--lvis-radius"]).toBe("0.6rem");
  });

  it("light/default — bg is white", () => {
    const tokens = resolvePluginTokens("light", "default");
    expect(tokens["--lvis-bg"]).toBe("hsl(0, 0%, 100%)");
  });

  it("high-contrast — primary is yellow regardless of chatTheme", () => {
    const hc = resolvePluginTokens("high-contrast", "purple");
    expect(hc["--lvis-primary"]).toBe("hsl(60, 100%, 50%)");
    // No chatTheme overlay should apply
    expect(hc["--lvis-primary"]).not.toMatch(/262/);
  });

  it("dark/lg — uses LG surface (Grey-1 bg) and vivid purple primary", () => {
    const tokens = resolvePluginTokens("dark", "lg");
    expect(tokens["--lvis-bg"]).toBe("hsl(0, 0%, 15%)");           // Grey-1
    expect(tokens["--lvis-primary"]).toBe("hsl(253, 100%, 65%)");   // #734dff
    expect(tokens["--lvis-danger"]).toBe("hsl(1, 98%, 59%)");       // LG red
  });

  it("light/lg — uses warm-grey surface", () => {
    const tokens = resolvePluginTokens("light", "lg");
    expect(tokens["--lvis-bg"]).toBe("hsl(40, 25%, 92%)");  // Grey-6 #F0ECE4
    expect(tokens["--lvis-primary"]).toBe("hsl(253, 100%, 65%)");
  });

  it("dark/purple — only primary/ring change, surface stays dark", () => {
    const tokens = resolvePluginTokens("dark", "purple");
    expect(tokens["--lvis-primary"]).toBe("hsl(262, 83%, 58%)");
    expect(tokens["--lvis-bg"]).toBe("hsl(222.2, 84%, 4.9%)");  // dark base unchanged
  });

  it("light/orange vs dark/orange — primary differs by shell", () => {
    const darkOrange = resolvePluginTokens("dark", "orange");
    const lightOrange = resolvePluginTokens("light", "orange");
    expect(darkOrange["--lvis-primary"]).not.toBe(lightOrange["--lvis-primary"]);
  });

  it("ThemeProvider calls notifyPluginTheme with tokens field", async () => {
    const { api } = makeMockLvisApi();
    await act(async () => {
      render(<ThemeProvider api={api} initialPreference="dark" initialChatTheme="lg" initialCodeTheme="dark"><div /></ThemeProvider>);
    });
    expect(api.notifyPluginTheme).toHaveBeenCalled();
    const call = (api.notifyPluginTheme as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tokens).toBeDefined();
    expect(typeof call.tokens["--lvis-bg"]).toBe("string");
    expect(call.tokens["--lvis-primary"]).toBe("hsl(253, 100%, 65%)");  // LG purple
  });
});
