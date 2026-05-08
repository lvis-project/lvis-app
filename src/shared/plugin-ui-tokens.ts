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

import { BUNDLE_IDS } from "./theme-bundles.js";

/**
 * Re-export of the canonical bundle id list from `theme-bundles.ts`.
 *
 * `theme-bundles.ts` is the single source of truth (used by settings-store,
 * plugins IPC, and the renderer). This re-export exists so that the Plugin
 * SDK — which syncs this file via `bun run sync:from-host` — can expose the
 * list under the stable public name `LVIS_THEME_BUNDLE_IDS` without
 * duplicating the array.
 *
 * Use {@link isLvisThemeBundleId} for safe runtime validation.
 *
 * @example
 * import { LVIS_THEME_BUNDLE_IDS, isLvisThemeBundleId } from "@lvis/plugin-sdk/ui/tokens";
 * if (isLvisThemeBundleId(id)) { /* id narrowed to LvisThemeBundleId *\/ }
 */
export const LVIS_THEME_BUNDLE_IDS = BUNDLE_IDS;

/**
 * Theme bundle identifiers shipped by the host.
 * Each bundle maps to a full token set (dark/light/contrast variants).
 * Derived from {@link LVIS_THEME_BUNDLE_IDS} — the runtime single source of truth.
 */
export type LvisThemeBundleId = (typeof LVIS_THEME_BUNDLE_IDS)[number];

/**
 * Type guard for `LvisThemeBundleId`.
 *
 * Casts `LVIS_THEME_BUNDLE_IDS` to `readonly string[]` before calling
 * `includes()` to satisfy TypeScript's narrowed `as const` type.
 *
 * @example
 * import { isLvisThemeBundleId } from "@lvis/plugin-sdk/ui/tokens";
 * if (isLvisThemeBundleId(rawId)) { /* rawId narrowed to LvisThemeBundleId *\/ }
 */
export function isLvisThemeBundleId(id: string): id is LvisThemeBundleId {
  return (LVIS_THEME_BUNDLE_IDS as readonly string[]).includes(id);
}

/**
 * LvisHostThemeEvent v2 — broadcast by the host on every theme change.
 *
 * **v2 migration**: legacy fields `colorScheme`, `reducedMotion`, and `fonts`
 * (previously on `LvisThemePayload`) have been removed. Use `bundleId` + `shell`
 * instead.
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
 *
 * Legacy fields `colorScheme`, `reducedMotion`, and `fonts` are no longer
 * emitted by the host. `bundleId` is now typed as {@link LvisThemeBundleId}
 * (narrowed from `string`).
 *
 * Migration: replace all `LvisThemePayload` usages with `LvisHostThemeEvent`.
 * These deprecated fields will be removed in a future cleanup PR.
 */
export interface LvisThemePayload extends LvisHostThemeEvent {
  /** @deprecated No longer emitted by the host. Use `bundleId` + `shell`. */
  colorScheme?: "light" | "dark" | "system";
  /** @deprecated No longer emitted by the host. */
  reducedMotion?: boolean;
  /** @deprecated No longer emitted by the host. */
  fonts?: { family: string };
}
