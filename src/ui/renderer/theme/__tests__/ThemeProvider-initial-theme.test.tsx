import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../ThemeProvider.js";

// `useTheme()` consumer that surfaces the effective bundleId as text so
// the test can assert what the provider initialised with.
function Probe() {
  const { bundleId } = useTheme();
  return <span data-testid="bundle">{bundleId}</span>;
}

beforeEach(() => {
  // Reset documentElement state between tests so attribute checks don't
  // leak from one case into the next.
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  document.documentElement.style.cssText = "";
  // Clear any previous global injected by another test.
  delete (window as { __lvisInitialTheme?: unknown }).__lvisInitialTheme;
});

afterEach(() => {
  // Each `render()` adds a fresh container to document.body; vitest doesn't
  // auto-cleanup react-testing-library, so without this every test would
  // see prior tests' DOM and `getByTestId` would throw "found multiple".
  cleanup();
  delete (window as { __lvisInitialTheme?: unknown }).__lvisInitialTheme;
});

describe("ThemeProvider — initial theme (race-window-zero)", () => {
  it("reads window.__lvisInitialTheme.bundleId when initialBundleId prop is omitted", () => {
    (window as { __lvisInitialTheme: unknown }).__lvisInitialTheme = {
      bundleId: "midnight",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    expect(getByTestId("bundle").textContent).toBe("midnight");
  });

  it("explicit initialBundleId prop overrides the global", () => {
    (window as { __lvisInitialTheme: unknown }).__lvisInitialTheme = {
      bundleId: "midnight",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider initialBundleId="lge-light"><Probe /></ThemeProvider>
    );
    expect(getByTestId("bundle").textContent).toBe("lge-light");
  });

  it("falls back to DEFAULT_BUNDLE_ID when neither prop nor global is present", () => {
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    // DEFAULT_BUNDLE_ID is the registry's first entry; just assert the
    // provider produced *some* known bundle id (not empty).
    expect(getByTestId("bundle").textContent).toBeTruthy();
  });

  it("ignores invalid bundleId in the global and falls back", () => {
    (window as { __lvisInitialTheme: unknown }).__lvisInitialTheme = {
      bundleId: "totally-not-a-bundle",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    // Should fall back to DEFAULT_BUNDLE_ID (any valid registered bundle).
    expect(getByTestId("bundle").textContent).not.toBe("totally-not-a-bundle");
  });

  it("async settings hydrate later does not clobber the global-sourced initial (when values agree)", async () => {
    (window as { __lvisInitialTheme: unknown }).__lvisInitialTheme = {
      bundleId: "tokyo-night",
      shell: "dark",
      tokens: {},
    };
    const fakeApi = {
      getSettings: vi.fn().mockResolvedValue({
        appearance: { schemaVersion: 2, bundleId: "tokyo-night", followSystem: false },
      }),
      updateSettings: vi.fn(),
      notifyPluginTheme: vi.fn().mockResolvedValue(undefined),
    };
    const { getByTestId } = render(
      <ThemeProvider api={fakeApi as never}><Probe /></ThemeProvider>
    );
    await waitFor(() => {
      expect(fakeApi.getSettings).toHaveBeenCalled();
    });
    // Still tokyo-night — hydrate from settings agreed with the global.
    expect(getByTestId("bundle").textContent).toBe("tokyo-night");
  });
});
