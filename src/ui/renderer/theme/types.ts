/**
 * Theme system v2 public types.
 *
 * The three-axis model (ThemePreference × ChatThemePreference × CodeThemePreference)
 * is replaced by a single paired bundle (`bundleId`). Each bundle is a fully-
 * specified set of shell + chat + code tokens — no combinatorial mismatches.
 *
 * `ThemeContextValue` exposes:
 *   - `bundleId`         — the active bundle id (e.g. "tokyo-night")
 *   - `setBundle`        — live-set the bundle + persist
 *   - `resolved`         — derived shell ("light" | "dark") from the active bundle (`ResolvedShell`)
 *   - `followSystem`     — violet pair only: auto-switch based on prefers-color-scheme
 *   - `setFollowSystem`  — toggle followSystem (only meaningful for violet pair)
 *
 * Legacy type aliases (ThemePreference, ChatThemePreference, etc.) live in
 * `settings-store.ts` for the migration path only and are marked @internal.
 * New code should not import them — use bundleId exclusively.
 *
 * `resolved` is kept for backward compatibility with CustomTitleBar's
 * `optionalTheme.resolved` usage (maps to the active bundle's shell).
 */

/** Active bundle id. */
export type BundleId = string;

/** Derived shell color scheme from the active bundle. */
export type ResolvedShell = "light" | "dark";

export interface ThemeContextValue {
  /**
   * The user-configured bundle id (e.g. "violet-light" or "violet-dark").
   * When `followSystem` is active this may differ from `effectiveBundleId`.
   */
  bundleId: BundleId;
  /**
   * The bundle id actually applied to the DOM after resolving `followSystem`.
   * When `followSystem` is false this equals `bundleId`.
   * When `followSystem` is true and bundleId is a violet pair id, this reflects
   * the OS-resolved variant ("violet-light" or "violet-dark").
   */
  effectiveBundleId: BundleId;
  /**
   * Live-set the active bundle. Updates the DOM immediately and persists
   * to `~/.lvis/settings.json` via `api.updateSettings({ appearance: ... })`.
   */
  setBundle: (id: BundleId) => void;
  /**
   * Shell color scheme derived from the active bundle's `shell` field.
   * Kept for backward compatibility (CustomTitleBar uses `optionalTheme.resolved`).
   */
  resolved: ResolvedShell;
  /** When true (violet pair only): auto-switch violet-light/violet-dark on OS scheme change. */
  followSystem: boolean;
  /** Toggle followSystem persistence. Only meaningful when bundleId is "violet-light" or "violet-dark". */
  setFollowSystem: (next: boolean) => void;
}

/** Violet pair bundle ids that support followSystem. */
export const VIOLET_PAIR_IDS: readonly string[] = ["violet-light", "violet-dark"];
