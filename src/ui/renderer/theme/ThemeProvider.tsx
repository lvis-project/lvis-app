import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LvisApi } from "../types.js";
import { BUNDLES, DEFAULT_BUNDLE_ID, findBundle } from "./bundles/index.js";
import type { ThemeBundle } from "./bundles/index.js";
import { applyBundleToDocument, resolveSystemPair } from "./resolve-theme.js";
import { bundleToPluginTokens } from "./plugin-token-map.js";
export { bundleToPluginTokens };
import type { ThemeContextValue, BundleId, ResolvedShell } from "./types.js";
import { LGE_PAIR_IDS } from "./types.js";

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Map a ThemeBundle to the v1-compat `theme` field value.
 * High-contrast bundles report "high-contrast"; all others report their shell.
 * This preserves semantic meaning for plugins that read the legacy `theme` field.
 */
function legacyTheme(bundle: ThemeBundle): "light" | "dark" | "high-contrast" {
  if (bundle.highContrast) return "high-contrast";
  return bundle.shell;
}

/**
 * Map a ThemeBundle to the v1-compat `chatTheme` field value.
 * LGE bundles report "lg" so existing plugins that branch on chatTheme
 * continue to identify the LGE context correctly. All other bundles
 * report "default" — the minimal backward-compat contract.
 */
function legacyChatTheme(bundle: ThemeBundle): "default" | "lg" | "purple" | "orange" | "blue" {
  if (bundle.id === "lge-light" || bundle.id === "lge-dark") return "lg";
  return "default";
}

export interface ThemeProviderProps {
  api?: LvisApi;
  /** Initial bundle id — lets tests skip async hydrate. */
  initialBundleId?: BundleId;
  /** Initial followSystem — lets tests skip async hydrate. */
  initialFollowSystem?: boolean;
  children: ReactNode;
}

/**
 * Theme system v2 — single bundle provider.
 *
 * Manages one active ThemeBundle (selected by `bundleId`). On mount, hydrates
 * from `api.getSettings().appearance.bundleId`. On change, writes
 * `data-theme-bundle` on `<html>` and persists via `api.updateSettings`.
 *
 * For the LGE pair (lge-light / lge-dark), `followSystem` auto-switches the
 * active bundle based on `prefers-color-scheme`.
 */
export function ThemeProvider({
  api,
  initialBundleId = DEFAULT_BUNDLE_ID,
  initialFollowSystem = false,
  children,
}: ThemeProviderProps) {
  const resolveBundle = useCallback((id: BundleId): ThemeBundle => {
    return findBundle(id) ?? findBundle(DEFAULT_BUNDLE_ID)!;
  }, []);

  const [bundleId, setBundleIdState] = useState<BundleId>(initialBundleId);
  const [followSystem, setFollowSystemState] = useState<boolean>(initialFollowSystem);

  // Track mount + user-touched state so late getSettings() doesn't clobber
  // a user toggle that happened in the meantime.
  const userTouchedRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Hydrate from settings on mount.
  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void (async () => {
      try {
        const settings = await api.getSettings();
        if (cancelled || userTouchedRef.current || !mountedRef.current) return;
        const appearance = settings.appearance as { schemaVersion?: number; bundleId?: string; followSystem?: boolean } | undefined;
        const rawId = (appearance?.schemaVersion === 2 && typeof appearance.bundleId === "string")
          ? appearance.bundleId
          : DEFAULT_BUNDLE_ID;
        const nextId = findBundle(rawId) ? rawId : DEFAULT_BUNDLE_ID;
        const nextFollow = appearance?.followSystem === true;
        setBundleIdState(nextId);
        setFollowSystemState(nextFollow);
      } catch {
        /* ignore — boot continues with defaults */
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // Tick counter — incremented by the OS media query listener below.
  // Must be declared before effectiveBundleId so it is in scope for the dep array.
  const [osTick, setOsTick] = useState(0);

  // Derive the effective bundle — when followSystem is active and the bundleId
  // is part of the LGE pair, override with the OS-resolved variant.
  // osTick is included so any OS scheme change triggers a re-evaluation.
  const effectiveBundleId: BundleId = useMemo(() => {
    if (followSystem && LGE_PAIR_IDS.includes(bundleId)) {
      return resolveSystemPair();
    }
    return bundleId;
  }, [bundleId, followSystem, osTick]);

  const activeBundle: ThemeBundle = useMemo(
    () => resolveBundle(effectiveBundleId),
    [effectiveBundleId, resolveBundle],
  );

  // Apply bundle to DOM on every active bundle change.
  useEffect(() => {
    if (typeof document === "undefined") return;
    applyBundleToDocument(activeBundle);
  }, [activeBundle]);

  // Propagate bundle tokens to plugin webviews whenever active bundle changes.
  useEffect(() => {
    if (!api) return;
    const tokens = bundleToPluginTokens(activeBundle);
    void api.notifyPluginTheme({
      bundleId: activeBundle.id,
      shell: activeBundle.shell,
      // v1 compat fields — plugin-ui-shell.js and SDK plugins read `theme`
      theme: legacyTheme(activeBundle),
      chatTheme: legacyChatTheme(activeBundle),
      codeTheme: activeBundle.shell === "light" ? "light" : "dark",
      tokens,
    }).catch((err: unknown) => {
      if (typeof process !== "undefined" && process.env?.LVIS_DEV === "1") {
        console.warn("[theme-propagation] notifyPluginTheme failed:", err);
      }
    });
  }, [api, activeBundle]);

  // Live-follow OS preference when followSystem is active for LGE pair.
  // A tick counter forces effectiveBundleId to re-evaluate on OS scheme change.
  useEffect(() => {
    if (!followSystem || !LGE_PAIR_IDS.includes(bundleId)) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setOsTick((n) => n + 1);
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
  }, [followSystem, bundleId]);

  const persistAppearance = useCallback(
    (patch: { bundleId?: BundleId; followSystem?: boolean }) => {
      if (!api) return;
      void api
        .updateSettings({ appearance: { schemaVersion: 2, ...patch } })
        .catch(() => { /* ignore — local state already reflects */ });
    },
    [api],
  );

  const setBundle = useCallback(
    (id: BundleId) => {
      userTouchedRef.current = true;
      const safeId = findBundle(id) ? id : DEFAULT_BUNDLE_ID;
      setBundleIdState(safeId);
      persistAppearance({ bundleId: safeId });
    },
    [persistAppearance],
  );

  const setFollowSystem = useCallback(
    (next: boolean) => {
      userTouchedRef.current = true;
      setFollowSystemState(next);
      persistAppearance({ followSystem: next });
    },
    [persistAppearance],
  );

  const resolved: ResolvedShell = activeBundle.shell;

  const value = useMemo<ThemeContextValue>(
    () => ({
      bundleId,
      effectiveBundleId,
      setBundle,
      resolved,
      followSystem,
      setFollowSystem,
    }),
    [bundleId, effectiveBundleId, setBundle, resolved, followSystem, setFollowSystem],
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

/** @internal — exported for the bundle registry */
export { BUNDLES };
