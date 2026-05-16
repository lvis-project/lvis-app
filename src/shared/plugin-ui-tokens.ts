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
  // Derived tinted-surface tokens — pre-computed color-mix values shipped by the host.
  // Plugins use these directly instead of reinventing color-mix derivations.
  "--lvis-danger-bg-subtle",
  "--lvis-focus-shadow",
  "--lvis-primary-bg-strong",
  "--lvis-primary-bg-subtle",
  "--lvis-success-bg-subtle",
  "--lvis-surface-hover",
  "--lvis-warning-bg-subtle",
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

import { BUNDLE_IDS, type BundleId } from "./theme-bundles.js";

/**
 * Theme bundle identifiers shipped by the host.
 * Each bundle maps to a full token set (dark/light/contrast variants).
 * Aliases {@link BundleId} from `theme-bundles.ts` — the canonical source of truth.
 */
export type LvisThemeBundleId = BundleId;

/**
 * Immutable copy of the canonical bundle id list from `theme-bundles.ts`.
 *
 * `theme-bundles.ts` is the single source of truth (used by settings-store,
 * plugins IPC, and the renderer). This re-export exists so that the Plugin
 * SDK — which syncs this file via `bun run sync:from-host` — can expose the
 * list under the stable public name `LVIS_THEME_BUNDLE_IDS` without
 * duplicating the array.
 *
 * Spread + `Object.freeze` produces an immutable copy so that mutations
 * (e.g. `push`, `splice`) on this export cannot affect the canonical
 * `BUNDLE_IDS` array in `theme-bundles.ts` (settings-store / plugins IPC).
 *
 * Use {@link isLvisThemeBundleId} for safe runtime validation.
 *
 * @example
 * import { LVIS_THEME_BUNDLE_IDS, isLvisThemeBundleId } from "@lvis/plugin-sdk/ui/tokens";
 * if (isLvisThemeBundleId(id)) { /* id narrowed to LvisThemeBundleId *\/ }
 */
export const LVIS_THEME_BUNDLE_IDS: readonly LvisThemeBundleId[] = Object.freeze([...BUNDLE_IDS]) as readonly LvisThemeBundleId[];

/**
 * Type guard for `LvisThemeBundleId`.
 *
 * Accepts `unknown` at the boundary so callers need not pre-cast arbitrary
 * values (e.g. IPC payloads, JSON deserialized objects) before validating.
 *
 * @example
 * import { isLvisThemeBundleId } from "@lvis/plugin-sdk/ui/tokens";
 * if (isLvisThemeBundleId(rawId)) { /* rawId narrowed to LvisThemeBundleId *\/ }
 */
export function isLvisThemeBundleId(id: unknown): id is LvisThemeBundleId {
  return typeof id === "string" && (LVIS_THEME_BUNDLE_IDS as readonly string[]).includes(id);
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
  /** Active theme bundle identifier (e.g. `"tokyo-night"`, `"violet-light"`). */
  bundleId: LvisThemeBundleId;
  /** Shell color mode of the active bundle. */
  shell: "light" | "dark";
  /** Resolved CSS custom property values for the active bundle. */
  tokens: LvisTokenMap;
}

/**
 * @deprecated v2 SDK consumers — use {@link LvisHostThemeEvent} instead.
 *
 * Legacy standalone payload type. Preserves the old contract exactly:
 * only `bundleId` (as `string`), `colorScheme`, `reducedMotion`, and `fonts`.
 * Does **not** extend `LvisHostThemeEvent` — `shell` and `tokens` are NOT
 * part of this type, so SDK ≤ v4 consumers that pass
 * `{ bundleId: "...", colorScheme: "dark" }` continue to compile without error.
 *
 * v2 SDK consumers: use {@link LvisHostThemeEvent} directly.
 * Migration: replace all `LvisThemePayload` usages with `LvisHostThemeEvent`.
 * These deprecated fields will be removed in a future cleanup PR.
 */
export interface LvisThemePayload {
  /**
   * Active theme bundle identifier.
   *
   * Kept as `string` (not narrowed to {@link LvisThemeBundleId}) for
   * backward compatibility — SDK consumers may forward arbitrary strings.
   * Use {@link isLvisThemeBundleId} to validate at runtime boundaries.
   *
   * @deprecated Migrate to {@link LvisHostThemeEvent} which carries the
   *   narrowed `LvisThemeBundleId` type.
   */
  bundleId: string;
  /**
   * @deprecated No longer emitted by the host. Use `bundleId` + `shell`.
   * Only `"light" | "dark"` — matches host `validateThemePayload` accept range.
   * `"system"` is NOT part of the legacy contract and will be rejected by the host.
   */
  colorScheme?: "light" | "dark";
  /** @deprecated No longer emitted by the host. */
  reducedMotion?: boolean;
  /** @deprecated No longer emitted by the host. */
  fonts?: { family: string };
}
