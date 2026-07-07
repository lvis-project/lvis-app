/**
 * Theme system v2 — ThemeProvider unit tests.
 *
 * Covers:
 *  - applyBundleToDocument() writes data-theme-bundle + data-shell + class
 *  - resolveSystemPair() returns violet-light/violet-dark based on matchMedia
 *  - <ThemeProvider> hydrates bundleId from settings (v2 shape)
 *  - setBundle persists + updates DOM
 *  - followSystem toggle (violet pair) persists + tracks OS scheme
 *  - bundleToPluginTokens() returns correct token map
 *  - useTheme outside provider throws
 *  - useOptionalTheme returns null without provider
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ThemeProvider, useTheme, useOptionalTheme } from "../theme/ThemeProvider.js";
import { applyBundleToDocument, resolveSystemPair } from "../theme/resolve-theme.js";
import { bundleToPluginTokens } from "../theme/plugin-token-map.js";
import {
  findBundle,
  DEFAULT_BUNDLE_ID,
  loadAllThemeBundles,
  resetLoadedThemeBundleCacheForTests,
  setThemeBundleLoaderOverrideForTests,
} from "../theme/bundles/index.js";
import { makeMockLvisApi } from "../../../../test/renderer/mock-lvis-api.js";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  // Remove all lvis-bundle-* classes
  Array.from(document.documentElement.classList)
    .filter((c) => c.startsWith("lvis-bundle-"))
    .forEach((c) => document.documentElement.classList.remove(c));
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  resetLoadedThemeBundleCacheForTests();
  await loadAllThemeBundles();
});

describe("applyBundleToDocument", () => {
  it("writes data-theme-bundle and data-shell", () => {
    const bundle = findBundle("tokyo-night")!;
    applyBundleToDocument(bundle);
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("tokyo-night");
    expect(document.documentElement.getAttribute("data-shell")).toBe("dark");
  });

  it("adds lvis-bundle-<id> class", () => {
    const bundle = findBundle("forest")!;
    applyBundleToDocument(bundle);
    expect(document.documentElement.classList.contains("lvis-bundle-forest")).toBe(true);
  });

  it("removes prior lvis-bundle-* class when switching", () => {
    applyBundleToDocument(findBundle("tokyo-night")!);
    applyBundleToDocument(findBundle("forest")!);
    expect(document.documentElement.classList.contains("lvis-bundle-tokyo-night")).toBe(false);
    expect(document.documentElement.classList.contains("lvis-bundle-forest")).toBe(true);
  });

  it("sets data-shell=light for light bundles", () => {
    applyBundleToDocument(findBundle("violet-light")!);
    expect(document.documentElement.getAttribute("data-shell")).toBe("light");
  });
});

describe("resolveSystemPair", () => {
  it("returns violet-light when prefers-color-scheme: light matches", () => {
    const win = { matchMedia: () => ({ matches: true } as MediaQueryList) } as unknown as Window;
    expect(resolveSystemPair(win)).toBe("violet-light");
  });

  it("returns violet-dark when prefers-color-scheme: light does not match", () => {
    const win = { matchMedia: () => ({ matches: false } as MediaQueryList) } as unknown as Window;
    expect(resolveSystemPair(win)).toBe("violet-dark");
  });

  it("returns violet-dark fallback when matchMedia is unavailable", () => {
    expect(resolveSystemPair(undefined)).toBe("violet-dark");
  });
});

describe("bundleToPluginTokens", () => {
  it("tokyo-night bundle — returns full --lvis-* token map with correct key count", () => {
    const bundle = findBundle("tokyo-night")!;
    const tokens = bundleToPluginTokens(bundle);
    // Should have at least 20 keys (invariant + bundle-specific)
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(20);
    expect(typeof tokens["--lvis-bg"]).toBe("string");
    expect(tokens["--lvis-bg"]).toMatch(/^hsl\(/);
    expect(tokens["--lvis-radius"]).toBe("0.6rem");
  });

  it("violet-dark — primary maps to vivid purple", () => {
    const bundle = findBundle("violet-dark")!;
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--lvis-primary"]).toContain("253");  // hsl(253, 100%, 65%)
  });

  it("high-contrast — primary is yellow", () => {
    const bundle = findBundle("high-contrast")!;
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--lvis-primary"]).toContain("60");  // hsl(60, 100%, 50%)
  });

  it("forest bundle — bg is white (light shell)", () => {
    const bundle = findBundle("forest")!;
    const tokens = bundleToPluginTokens(bundle);
    // forest background = "0 0% 100%" → hsl(0, 0%, 100%)
    expect(tokens["--lvis-bg"]).toContain("100%");
  });
});

describe("<ThemeProvider>", () => {
  function Probe({ onValue }: { onValue: (v: ReturnType<typeof useTheme>) => void }) {
    const v = useTheme();
    useEffect(() => { onValue(v); }, [v, onValue]);
    return null;
  }

  it("hydrates bundleId from api.getSettings() on mount (v2 shape)", async () => {
    const { api } = makeMockLvisApi({
      settings: {
        llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        appearance: { schemaVersion: 2, bundleId: "midnight" },
      },
    });
    const seen: string[] = [];
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => seen.push(v.bundleId)} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(seen).toContain("midnight");
    });
    expect(api.getSettings).toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
  });

  it("falls back to DEFAULT_BUNDLE_ID when settings load fails", async () => {
    const { api } = makeMockLvisApi();
    api.getSettings.mockRejectedValueOnce(new Error("boom"));
    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).not.toBeNull();
    });
    expect(observed).toBe(DEFAULT_BUNDLE_ID);
  });

  it("setBundle persists via api.updateSettings and updates DOM", async () => {
    const { api } = makeMockLvisApi();
    let setter: ((id: string) => void) | null = null;
    function Capture() {
      const { setBundle } = useTheme();
      setter = setBundle;
      return null;
    }
    render(
      <ThemeProvider api={api as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("midnight"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
    });
    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ bundleId: "midnight" }) }),
    );
  });

  it("applies settings:update broadcasts from another window without restart", async () => {
    const { api } = makeMockLvisApi({
      settings: {
        llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
        chat: { systemPrompt: "", autoCompact: true },
        webSearch: { provider: "none" },
        appearance: { schemaVersion: 2, bundleId: "tokyo-night" },
      },
    });
    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("tokyo-night");
    });

    await act(async () => {
      await api.updateSettings({ appearance: { schemaVersion: 2, bundleId: "forest" } });
    });

    await waitFor(() => {
      expect(observed).toBe("forest");
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("forest");
    });
  });

  it("persistence roundtrip: set midnight → simulated reload → still midnight", async () => {
    let stored: { schemaVersion: 2; bundleId: string } = { schemaVersion: 2, bundleId: "tokyo-night" };
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
    let setter: ((id: string) => void) | null = null;
    function Capture() {
      const { setBundle } = useTheme();
      setter = setBundle;
      return null;
    }
    const first = render(
      <ThemeProvider api={api1 as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("midnight"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
    });
    expect(stored.bundleId).toBe("midnight");
    first.unmount();

    const { api: api2 } = makeMockLvisApi({
      settings: { ...settingsBacking, appearance: stored },
    });
    let observed: string | null = null;
    render(
      <ThemeProvider api={api2 as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("midnight");
    });
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
  });

  it("uses initialBundleId when no api is provided", () => {
    let observed: string | null = null;
    render(
      <ThemeProvider initialBundleId="high-contrast">
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    expect(observed).toBe("high-contrast");
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("high-contrast");
  });

  it("lazy-loads a marketplace initialBundleId from a cold bundle cache", async () => {
    resetLoadedThemeBundleCacheForTests();
    expect(findBundle("tokyo-night")).toBeUndefined();

    let observed: string | null = null;
    render(
      <ThemeProvider initialBundleId="tokyo-night">
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(observed).toBe("tokyo-night");
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("tokyo-night");
    });
  });

  it("falls back to the default bundle when a marketplace theme chunk fails", async () => {
    resetLoadedThemeBundleCacheForTests();
    setThemeBundleLoaderOverrideForTests("tokyo-night", async () => {
      throw new Error("chunk unavailable");
    });

    let observed: string | null = null;
    render(
      <ThemeProvider initialBundleId="tokyo-night">
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(observed).toBe(DEFAULT_BUNDLE_ID);
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe(DEFAULT_BUNDLE_ID);
    });
  });

  it("useTheme throws when called outside the provider", () => {
    function BadConsumer() {
      useTheme();
      return null;
    }
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

  it("resolved property reflects active bundle shell", async () => {
    let observed: string | null = null;
    function Capture() {
      const { resolved } = useTheme();
      useEffect(() => { observed = resolved; }, [resolved]);
      return null;
    }
    render(
      <ThemeProvider initialBundleId="forest">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(observed).toBe("light"); });
  });

  it("setFollowSystem persists and is togglable", async () => {
    const { api } = makeMockLvisApi();
    let setter: ((next: boolean) => void) | null = null;
    let observed: boolean | null = null;
    function Capture() {
      const { setFollowSystem, followSystem } = useTheme();
      setter = setFollowSystem;
      useEffect(() => { observed = followSystem; }, [followSystem]);
      return null;
    }
    render(
      <ThemeProvider api={api as never} initialBundleId="violet-dark">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!(true); });
    await waitFor(() => { expect(observed).toBe(true); });
    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ followSystem: true }) }),
    );
  });

  it("ThemeProvider calls notifyPluginTheme with tokens field", async () => {
    const { api } = makeMockLvisApi();
    await act(async () => {
      render(
        <ThemeProvider api={api} initialBundleId="violet-dark">
          <div />
        </ThemeProvider>,
      );
    });
    expect(api.notifyPluginTheme).toHaveBeenCalled();
    const call = (api.notifyPluginTheme as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tokens).toBeDefined();
    expect(typeof call.tokens["--lvis-bg"]).toBe("string");
    expect(call.tokens["--lvis-primary"]).toContain("253");  // vivid purple
  });
});

describe("<ThemeProvider> + reduced-motion", () => {
  beforeEach(() => {
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

  it("does not throw and applies bundle cleanly when reduced-motion is set", () => {
    render(
      <ThemeProvider initialBundleId="tokyo-night">
        <div />
      </ThemeProvider>,
    );
    const inline = document.documentElement.getAttribute("style") ?? "";
    expect(inline).not.toMatch(/transition/i);
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("tokyo-night");
  });
});
