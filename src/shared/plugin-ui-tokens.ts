/**
 * Host-owned plugin UI token contract.
 *
 * The app runtime is the source of truth for plugin theme payload validation
 * and theme token broadcasts. The SDK copies this module into its public
 * `@lvis/plugin-sdk/ui/tokens` surface via `bun run sync:from-host`.
 */
export const LVIS_TOKEN_NAMES = [
  "--lvis-bg",
  "--lvis-surface",
  "--lvis-surface-overlay",
  "--lvis-fg",
  "--lvis-fg-muted",
  "--lvis-fg-disabled",
  "--lvis-primary",
  "--lvis-primary-fg",
  "--lvis-secondary",
  "--lvis-secondary-fg",
  "--lvis-danger",
  "--lvis-danger-fg",
  "--lvis-warning",
  "--lvis-warning-fg",
  "--lvis-success",
  "--lvis-success-fg",
  "--lvis-border",
  "--lvis-ring",
  "--lvis-radius-xs",
  "--lvis-radius-sm",
  "--lvis-radius",
  "--lvis-radius-lg",
  "--lvis-radius-full",
  "--lvis-text-xs",
  "--lvis-text-sm",
  "--lvis-text-base",
  "--lvis-text-lg",
  "--lvis-weight-normal",
  "--lvis-weight-medium",
  "--lvis-weight-semibold",
  "--lvis-space-1",
  "--lvis-space-2",
  "--lvis-space-3",
  "--lvis-space-4",
  "--lvis-motion-fast",
  "--lvis-motion-normal",
] as const;

export type LvisTokenName = typeof LVIS_TOKEN_NAMES[number];

export type LvisTokenMap = { readonly [K in LvisTokenName]: string };

/** @deprecated Use LvisTokenMap instead. */
export type LvisThemeTokens = LvisTokenMap;

/**
 * CSS-only static tokens — defined in the SDK fallback stylesheet as offline
 * defaults, but not sent over IPC because their value syntax is broader than
 * the host's safe token-value allowlist.
 */
export const LVIS_CSS_ONLY_TOKEN_NAMES = [
  "--lvis-shadow-sm",
  "--lvis-shadow-md",
  "--lvis-easing",
] as const;

export type LvisCssOnlyTokenName = typeof LVIS_CSS_ONLY_TOKEN_NAMES[number];

/**
 * Runtime allowlist of theme bundle identifiers shipped by the host.
 * Single source of truth — `LvisThemeBundleId` is derived from this array.
 *
 * Use this for runtime validation (e.g. `LVIS_THEME_BUNDLE_IDS.includes(id)`).
 */
export const LVIS_THEME_BUNDLE_IDS = [
  "tokyo-night",
  "midnight",
  "forest",
  "lge-light",
  "lge-dark",
  "high-contrast",
] as const;

/**
 * Theme bundle identifiers shipped by the host.
 * Each bundle maps to a full token set (dark/light/contrast variants).
 * Derived from {@link LVIS_THEME_BUNDLE_IDS} — the runtime single source of truth.
 */
export type LvisThemeBundleId = (typeof LVIS_THEME_BUNDLE_IDS)[number];

/**
 * LvisHostThemeEvent v2 — broadcast by the host on every theme change.
 *
 * **v2 breaking change**: `theme`, `chatTheme`, and `codeTheme` fields
 * have been removed. Use `bundleId` + `shell` instead.
 *
 * Emitted on the `"host.theme.changed"` event bus channel.
 */
export interface LvisHostThemeEvent {
  /** Active theme bundle identifier (e.g. `"tokyo-night"`, `"lge-light"`). */
  bundleId: LvisThemeBundleId;
  /** Shell color mode of the active bundle. */
  shell: "light" | "dark";
  /** Resolved CSS custom property values for the active bundle. */
  tokens: LvisTokenMap;
}

/**
 * @deprecated Use {@link LvisHostThemeEvent} instead.
 * Kept only as a type alias name for documentation purposes — no runtime value.
 */
export type LvisThemePayload = LvisHostThemeEvent;
