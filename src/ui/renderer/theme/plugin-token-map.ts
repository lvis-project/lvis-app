import type { ThemeBundle } from "./bundles/index.js";
import type { LvisTokenName } from "../../../shared/plugin-ui-tokens.js";

// Derives the full set of --lvis-* CSS custom properties from an active ThemeBundle.
// Values are literal HSL strings so plugins can apply them without needing any of
// the host's --p-* palette or var() chain.
const _H = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;
// Tailwind alpha syntax: "H S% L% / A" or "H S% L% / A%". Capture alpha
// optionally so bundle tokens that opt into translucent values still wrap to a
// valid `hsl()` for plugin webviews (which cannot consume bare triples).
const _HSL_RE = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%(?:\s*\/\s*(\d+(?:\.\d+)?%?))?$/;

/**
 * Convert an HSL triple string ("H S% L%" or "H S% L% / A%") to a CSS
 * `hsl(H, S%, L%)` / `hsla(H, S%, L%, A%)` value. Bundle tokens are stored as
 * bare HSL triples (Tailwind format); plugin webviews need the full wrapper.
 */
function tripleToHsl(triple: string): string {
  const m = _HSL_RE.exec(triple.trim());
  if (!m) return triple; // already formatted or raw value
  if (m[4] === undefined) return `hsl(${m[1]}, ${m[2]}%, ${m[3]}%)`;
  return `hsla(${m[1]}, ${m[2]}%, ${m[3]}%, ${m[4]})`;
}

// Theme-invariant tokens — same across all bundles.
//
// These values reach plugin webviews via the primed token payload that
// `main.ts:initialThemeArgs` ships on every `BrowserWindow` (commit 1696f92,
// closes lvis-app#667). The SDK no longer carries a fallback stylesheet; the
// host is the single source for what plugins paint.
const _INVARIANT: Partial<Record<LvisTokenName, string>> = {
  "--lvis-radius-xs":       "0.15rem",
  "--lvis-radius-lg":       "0.75rem",
  "--lvis-radius-full":     "9999px",
  "--lvis-text-xs":         "0.75rem",
  "--lvis-text-sm":         "0.875rem",
  "--lvis-text-base":       "1rem",
  "--lvis-text-lg":         "1.125rem",
  "--lvis-weight-normal":   "400",
  "--lvis-weight-medium":   "500",
  "--lvis-weight-semibold": "600",
  "--lvis-space-1":         "0.25rem",
  "--lvis-space-2":         "0.5rem",
  "--lvis-space-3":         "0.75rem",
  "--lvis-space-4":         "1rem",
  "--lvis-motion-fast":     "150ms",
  "--lvis-motion-normal":   "200ms",
};

/**
 * Build a color-mix() tinted surface value.
 *
 * @param color  - Resolved CSS color for the tint (e.g. `hsl(217, 91%, 60%)`)
 * @param base   - Resolved CSS color for the base surface (e.g. `hsl(222, 84%, 5%)`)
 * @param pct    - Percentage of `color` to mix in (remainder is `base`)
 */
function _tint(color: string, base: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, ${base})`;
}

/**
 * Derive the full --lvis-* plugin token map from an active ThemeBundle.
 *
 * Bundles are self-contained — no legacy axis resolution needed.
 */
export function bundleToPluginTokens(bundle: ThemeBundle): Record<LvisTokenName, string> {
  const t = bundle.tokens;
  const isLight = bundle.shell === "light";
  const isHighContrast = bundle.highContrast;

  // Resolved base colors reused for derivations.
  const primary   = tripleToHsl(t.primary);
  const surface   = tripleToHsl(t.card);
  const danger    = tripleToHsl(t.destructive);
  const warning   = tripleToHsl(t.warning);
  const success   = tripleToHsl(t.success);
  const secondary = tripleToHsl(t.secondary);
  const fg        = tripleToHsl(t.foreground);
  const ring      = tripleToHsl(t.ring);

  // Mix percentages scale by shell mode and high-contrast requirement.
  // AA contrast on dark surfaces; HC bundle bumps mix to 24/40 for elevated contrast over body background.
  const primarySubtlePct = isHighContrast ? 24 : isLight ? 14 : 18;
  const primaryStrongPct = isHighContrast ? 40 : isLight ? 28 : 32;
  const statusSubtlePct  = isHighContrast ? 24 : 14;
  const hoverPct         = isHighContrast ? 14 : isLight ?  6 : 10;

  const bundleTokens: Partial<Record<LvisTokenName, string>> = {
    "--lvis-bg":              tripleToHsl(t.background),
    "--lvis-surface":         surface,
    "--lvis-surface-overlay": tripleToHsl(t.popover),
    "--lvis-fg":              fg,
    "--lvis-fg-muted":        tripleToHsl(t["muted-foreground"]),
    "--lvis-fg-disabled":     tripleToHsl(t["muted-foreground"]),
    "--lvis-primary":         primary,
    "--lvis-primary-fg":      tripleToHsl(t["primary-foreground"]),
    "--lvis-secondary":       secondary,
    "--lvis-secondary-fg":    tripleToHsl(t["secondary-foreground"]),
    "--lvis-danger":          danger,
    "--lvis-danger-fg":       tripleToHsl(t["destructive-foreground"]),
    "--lvis-warning":         warning,
    "--lvis-warning-fg":      tripleToHsl(t["warning-foreground"]),
    "--lvis-success":         success,
    "--lvis-success-fg":      _H(210, 40, 98),  // invariant — no component surfaces success-fg yet
    "--lvis-border":          tripleToHsl(t.border),
    "--lvis-ring":            ring,
    "--lvis-radius":          "0.6rem",
    "--lvis-radius-sm":       "0.25rem",
    // ── Derived tinted-surface tokens ────────────────────────────────────────
    // Pre-computed so plugins use var(--lvis-primary-bg-subtle) instead of
    // reinventing color-mix() across --pm-*, --accent-bg, --ah-* namespaces.
    "--lvis-primary-bg-subtle":  _tint(primary, surface, primarySubtlePct),
    "--lvis-primary-bg-strong":  _tint(primary, surface, primaryStrongPct),
    "--lvis-danger-bg-subtle":   _tint(danger,  "transparent", statusSubtlePct),
    "--lvis-warning-bg-subtle":  _tint(warning, "transparent", statusSubtlePct),
    "--lvis-success-bg-subtle":  _tint(success, "transparent", statusSubtlePct),
    "--lvis-surface-hover":      _tint(fg, secondary, hoverPct),
    "--lvis-focus-shadow":       _tint(ring, "transparent", 62),
  };
  return { ..._INVARIANT, ...bundleTokens } as Record<LvisTokenName, string>;
}

/**
 * @deprecated Use `bundleToPluginTokens(bundle)` instead.
 *
 * Legacy shim kept so existing callers (ThemeProvider tests that import
 * `resolvePluginTokens` from the barrel) continue to compile during the
 * transition. Will be removed in the next sprint.
 */
export { bundleToPluginTokens as resolvePluginTokens };
