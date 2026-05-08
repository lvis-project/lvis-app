import type { ThemeBundle } from "./bundles/index.js";
import type { LvisTokenName } from "../../../shared/plugin-ui-tokens.js";

// Derives the full set of --lvis-* CSS custom properties from an active ThemeBundle.
// Values are literal HSL strings so plugins can apply them without needing any of
// the host's --p-* palette or var() chain.
const _H = (h: number, s: number, l: number) => `hsl(${h}, ${s}%, ${l}%)`;
const _HSL_RE = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/;

/**
 * Convert an HSL triple string ("H S% L%") to an `hsl(H, S%, L%)` value.
 * Bundle tokens are stored as bare HSL triples (Tailwind format); plugin
 * webviews need the full `hsl()` wrapper.
 */
function tripleToHsl(triple: string): string {
  const m = _HSL_RE.exec(triple.trim());
  if (!m) return triple; // already formatted or raw value
  return `hsl(${m[1]}, ${m[2]}%, ${m[3]}%)`;
}

// Theme-invariant tokens — same across all bundles.
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
 * Derive the full --lvis-* plugin token map from an active ThemeBundle.
 *
 * Replaces the old `resolvePluginTokens(theme, chatTheme)` which required the
 * caller to carry both axes. Bundles are self-contained so no axis resolution
 * is needed.
 */
export function bundleToPluginTokens(bundle: ThemeBundle): Record<LvisTokenName, string> {
  const t = bundle.tokens;
  const bundleTokens: Partial<Record<LvisTokenName, string>> = {
    "--lvis-bg":              tripleToHsl(t.background),
    "--lvis-surface":         tripleToHsl(t.card),
    "--lvis-surface-overlay": tripleToHsl(t["card-foreground"]),
    "--lvis-fg":              tripleToHsl(t.foreground),
    "--lvis-fg-muted":        tripleToHsl(t["muted-foreground"]),
    "--lvis-fg-disabled":     tripleToHsl(t["accent-foreground"]),
    "--lvis-primary":         tripleToHsl(t.primary),
    "--lvis-primary-fg":      tripleToHsl(t["primary-foreground"]),
    "--lvis-secondary":       tripleToHsl(t.secondary),
    "--lvis-secondary-fg":    tripleToHsl(t["secondary-foreground"]),
    "--lvis-danger":          tripleToHsl(t.destructive),
    "--lvis-danger-fg":       tripleToHsl(t["destructive-foreground"]),
    "--lvis-warning":         tripleToHsl(t.warning),
    "--lvis-warning-fg":      tripleToHsl(t["warning-foreground"]),
    "--lvis-success":         tripleToHsl(t.success),
    "--lvis-success-fg":      _H(210, 40, 98),  // invariant — no component surfaces success-fg yet
    "--lvis-border":          tripleToHsl(t.border),
    "--lvis-ring":            tripleToHsl(t.ring),
    "--lvis-radius":          "0.6rem",
    "--lvis-radius-sm":       "0.25rem",
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
