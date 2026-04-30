import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LvisApi } from "../types.js";
import { applyThemeToDocument, resolveTheme } from "./resolve-theme.js";
import type { ResolvedTheme, ThemeContextValue, ThemePreference } from "./types.js";

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * UX Track 3 — single global theme provider.
 *
 * Responsibilities:
 *   - Hydrate from `api.getSettings().appearance.theme` on mount.
 *   - Apply the resolved theme to `<html data-theme="…">` so the semantic
 *     CSS-variable block in styles.css activates.
 *   - When preference is "system", listen to `prefers-color-scheme` and
 *     re-resolve live (no reload).
 *   - Persist preference changes through `api.updateSettings({ appearance })`.
 *
 * `initialPreference` lets tests skip the async hydrate; production renders
 * with "system" until the first getSettings() call lands.
 *
 * Adding a new theme variant: extend `ThemePreference` in
 * `src/data/settings-store.ts`, add the `[data-theme="<id>"]` block in
 * `src/styles.css`, then add an entry to `THEME_PREFERENCES` in `./types.ts`.
 */
export interface ThemeProviderProps {
  api?: LvisApi;
  initialPreference?: ThemePreference;
  children: ReactNode;
}

export function ThemeProvider({ api, initialPreference = "system", children }: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(initialPreference));

  // Track mount state so a late getSettings() resolution doesn't clobber a
  // user toggle that happened in the meantime.
  const userTouchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Hydrate from settings on mount. Failures fall back silently to whatever
  // `initialPreference` already produced — the app must boot even if
  // settings are unavailable (first launch, IPC mid-init, etc.).
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || userTouchedRef.current || !mountedRef.current) return;
        const next = settings.appearance?.theme ?? "system";
        setPreferenceState(next);
      } catch {
        /* ignore — boot continues with default */
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Apply to the DOM whenever the resolved theme changes. Wrapped in an
  // effect so SSR / non-DOM unit tests can render without crashing.
  useEffect(() => {
    if (typeof document === "undefined") return;
    applyThemeToDocument(resolved);
  }, [resolved]);

  // Re-resolve whenever the preference changes.
  useEffect(() => {
    setResolved(resolveTheme(preference));
  }, [preference]);

  // Live-follow OS preference when the user picked "system".
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setResolved(resolveTheme("system"));
    // addEventListener is the modern API; addListener is the Safari ≤ 13 /
    // older Electron fallback. We attach whichever is present.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    if (typeof (mql as unknown as { addListener?: (cb: () => void) => void }).addListener === "function") {
      (mql as unknown as { addListener: (cb: () => void) => void }).addListener(onChange);
      return () => {
        (mql as unknown as { removeListener: (cb: () => void) => void }).removeListener(onChange);
      };
    }
    return undefined;
  }, [preference]);

  const setPreference = useCallback(
    (next: ThemePreference) => {
      userTouchedRef.current = true;
      setPreferenceState(next);
      if (api) {
        // Best-effort persistence — UI never blocks on this.
        void api
          .updateSettings({ appearance: { theme: next } })
          .catch(() => { /* ignore — local state already reflects the choice */ });
      }
    },
    [api],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/**
 * Read the current theme. Throws if used outside a ThemeProvider — that
 * would mean the App composition root forgot to mount it, which is a bug.
 */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme() must be used inside <ThemeProvider>");
  }
  return ctx;
}

/**
 * Test/escape hatch — returns null instead of throwing when no provider is
 * mounted. Useful for components that may render in isolated test harnesses
 * (Storybook, snapshot tests) without a full App context.
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
