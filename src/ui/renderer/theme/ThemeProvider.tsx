import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LvisApi } from "../types.js";
import {
  applyChatThemeToDocument,
  applyCodeThemeToDocument,
  applyThemeToDocument,
  resolveCodeTheme,
  resolveTheme,
} from "./resolve-theme.js";
import type {
  ChatThemePreference,
  CodeThemePreference,
  ResolvedCodeTheme,
  ResolvedTheme,
  ThemeContextValue,
  ThemePreference,
} from "./types.js";

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * UX Track 3 — single global theme provider.
 *
 * Manages three independent axes:
 *   - `preference`  → `<html data-theme="...">`        (shell light/dark/HC)
 *   - `chatTheme`   → `<html data-chat-theme="...">`   (accent overlay)
 *   - `codeTheme`   → `<html data-code-theme="...">`   (code-surface scheme)
 *
 * Responsibilities:
 *   - Hydrate from `api.getSettings().appearance.{theme,chatTheme,codeTheme}`
 *     on mount.
 *   - Apply each axis to <html> so the corresponding CSS-variable block in
 *     styles.css activates.
 *   - When preference is "system", listen to `prefers-color-scheme` and
 *     re-resolve live (no reload). codeTheme="auto" follows that resolution.
 *   - Persist preference changes through `api.updateSettings({ appearance })`.
 *
 * `initialPreference` / `initialChatTheme` / `initialCodeTheme` let tests
 * skip the async hydrate; production renders with the defaults until the
 * first getSettings() call lands.
 *
 * Adding a new chat theme:
 *  1. Add the literal to `ChatThemePreference` in `src/data/settings-store.ts`
 *     and `VALID_CHAT_THEMES`.
 *  2. Mirror the union in `src/ui/renderer/theme/types.ts` and append to
 *     `CHAT_THEME_PREFERENCES`.
 *  3. Add a `[data-chat-theme="<id>"]` block in `src/styles.css` that
 *     remaps `--primary` and `--ring` (and any other accent tokens).
 *  4. Add an entry to the `CHAT_OPTIONS` array in
 *     `src/ui/renderer/tabs/AppearanceTab.tsx`.
 */
export interface ThemeProviderProps {
  api?: LvisApi;
  initialPreference?: ThemePreference;
  initialChatTheme?: ChatThemePreference;
  initialCodeTheme?: CodeThemePreference;
  children: ReactNode;
}

export function ThemeProvider({
  api,
  initialPreference = "system",
  initialChatTheme = "purple",
  initialCodeTheme = "auto",
  children,
}: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);
  const [chatTheme, setChatThemeState] = useState<ChatThemePreference>(initialChatTheme);
  const [codeTheme, setCodeThemeState] = useState<CodeThemePreference>(initialCodeTheme);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(initialPreference));

  // Track mount state so a late getSettings() resolution doesn't clobber a
  // user toggle that happened in the meantime.
  const userTouchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Hydrate from settings on mount. Failures fall back silently to whatever
  // the initial values already produced — the app must boot even if
  // settings are unavailable (first launch, IPC mid-init, etc.).
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || userTouchedRef.current || !mountedRef.current) return;
        const next = settings.appearance?.theme ?? "system";
        const nextChat = (settings.appearance?.chatTheme as ChatThemePreference | undefined) ?? "purple";
        const nextCode = (settings.appearance?.codeTheme as CodeThemePreference | undefined) ?? "auto";
        setPreferenceState(next);
        setChatThemeState(nextChat);
        setCodeThemeState(nextCode);
      } catch {
        /* ignore — boot continues with default */
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Propagate theme to plugin webviews whenever any axis changes.
  useEffect(() => {
    if (!api) return;
    void api.notifyPluginTheme({ theme: resolved, chatTheme, codeTheme: resolvedCodeTheme }).catch(() => {});
  }, [api, resolved, chatTheme, resolvedCodeTheme]);

  // Apply shell theme to the DOM whenever the resolved theme changes. Wrapped
  // in an effect so SSR / non-DOM unit tests can render without crashing.
  useEffect(() => {
    if (typeof document === "undefined") return;
    applyThemeToDocument(resolved);
  }, [resolved]);

  // Apply chat accent overlay whenever the user changes it.
  useEffect(() => {
    if (typeof document === "undefined") return;
    applyChatThemeToDocument(chatTheme);
  }, [chatTheme]);

  // Resolve + apply code-theme. Depends on both the user preference and the
  // resolved shell (so "auto" follows shell flips live).
  const resolvedCodeTheme: ResolvedCodeTheme = useMemo(
    () => resolveCodeTheme(codeTheme, resolved),
    [codeTheme, resolved],
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    applyCodeThemeToDocument(resolvedCodeTheme);
  }, [resolvedCodeTheme]);

  // Re-resolve the shell theme whenever the preference changes.
  useEffect(() => {
    setResolved(resolveTheme(preference));
  }, [preference]);

  // Live-follow OS preference when the user picked "system".
  useEffect(() => {
    if (preference !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setResolved(resolveTheme("system"));
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

  const persistAppearance = useCallback(
    (patch: { theme?: ThemePreference; chatTheme?: ChatThemePreference; codeTheme?: CodeThemePreference }) => {
      if (!api) return;
      // Best-effort persistence — UI never blocks on this.
      void api
        .updateSettings({ appearance: patch })
        .catch(() => { /* ignore — local state already reflects the choice */ });
    },
    [api],
  );

  const setPreference = useCallback(
    (next: ThemePreference) => {
      userTouchedRef.current = true;
      setPreferenceState(next);
      persistAppearance({ theme: next });
    },
    [persistAppearance],
  );

  const setChatTheme = useCallback(
    (next: ChatThemePreference) => {
      userTouchedRef.current = true;
      setChatThemeState(next);
      persistAppearance({ chatTheme: next });
    },
    [persistAppearance],
  );

  const setCodeTheme = useCallback(
    (next: CodeThemePreference) => {
      userTouchedRef.current = true;
      setCodeThemeState(next);
      persistAppearance({ codeTheme: next });
    },
    [persistAppearance],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolved,
      chatTheme,
      codeTheme,
      resolvedCodeTheme,
      setPreference,
      setChatTheme,
      setCodeTheme,
    }),
    [preference, resolved, chatTheme, codeTheme, resolvedCodeTheme, setPreference, setChatTheme, setCodeTheme],
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
