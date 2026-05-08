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

export interface LvisThemePayload {
  bundleId: string;
  shell: "light" | "dark";
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  fonts?: { family: string };
  tokens: LvisTokenMap;
}
