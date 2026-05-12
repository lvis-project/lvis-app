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
// Values intentionally mirror `@lvis/plugin-sdk/src/ui/tokens/fallback-dark.json`
// (the SDK's offline fallback SoT). Both must stay in lockstep so plugins
// see the same invariant tokens whether the host has broadcast yet or not.
// The drift gate is `__tests__/host-sdk-token-lockstep.test.ts`, which reads
// the SDK JSON via Node fs and asserts each key here matches. A direct
// JSON-subpath import was attempted but Vite/Rollup's resolver rejects
// non-JS subpath exports without a heavy SDK shim — the test-based gate is
// strictly equivalent operationally and avoids the bundler dance.
//
// Note: the SDK's `fallback-dark.json` is legacy from before commit 1696f92
// closed the cold-boot race via webPreferences.additionalArguments. Cleanup
// to drop the SDK fallback is tracked in lvis-app#667; until that SDK PR
// ships and we bump past it, this lockstep is the contract we maintain.
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
 * Internal export — single SoT for the invariant key list.
 *
 * The drift gate (`__tests__/host-sdk-token-lockstep.test.ts`) imports
 * this instead of hand-mirroring a parallel `INVARIANT_KEYS` array, so
 * adding a key to `_INVARIANT` automatically subjects it to the
 * lockstep check against `@lvis/plugin-sdk/.../fallback-dark.json` —
 * no second list to keep in sync, no false-negative drift.
 */
export const _INVARIANT_KEYS = Object.keys(_INVARIANT) as LvisTokenName[];

/**
 * Derive the full --lvis-* plugin token map from an active ThemeBundle.
 *
 * Bundles are self-contained — no legacy axis resolution needed.
 */
export function bundleToPluginTokens(bundle: ThemeBundle): Record<LvisTokenName, string> {
  const t = bundle.tokens;
  const bundleTokens: Partial<Record<LvisTokenName, string>> = {
    "--lvis-bg":              tripleToHsl(t.background),
    "--lvis-surface":         tripleToHsl(t.card),
    "--lvis-surface-overlay": tripleToHsl(t.popover),
    "--lvis-fg":              tripleToHsl(t.foreground),
    "--lvis-fg-muted":        tripleToHsl(t["muted-foreground"]),
    "--lvis-fg-disabled":     tripleToHsl(t["muted-foreground"]),
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
