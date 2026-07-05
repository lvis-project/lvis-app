/**
 * Pure SoT for user font-appearance guards (`settings.appearance.font`).
 *
 * Extracted so both the main-process settings store (`src/data/settings-store.ts`,
 * which validates on write) and the renderer preload (`src/preload.ts`, which
 * validates the frame-0 theme prime before painting `--lvis-font-size-scale` /
 * `--lvis-font-family` on documentElement) enforce the *same* contract without
 * one pulling the other's dependencies. This module has zero runtime imports —
 * it is safe to bundle into the sandboxed preload context, unlike
 * `settings-store.ts` (which imports `electron.safeStorage` + `node:fs`).
 *
 * `settings-store.ts` re-exports these so existing import sites are unchanged.
 */

/**
 * Allowed `font.sizeScale` presets — multiplicative on the `1rem` base.
 * Discrete values keep the UI legible at every step (a free slider would let
 * users pick `0.4` and lock themselves out of the settings dialog).
 */
export const FONT_SIZE_SCALE_VALUES = [0.875, 1, 1.125, 1.25] as const;
export type FontSizeScale = (typeof FONT_SIZE_SCALE_VALUES)[number];

export interface AppearanceFontSettings {
  /** `"system"` = HOST_FONT_STACK default; otherwise a validated raw CSS font-family stack. */
  family?: "system" | string;
  /** Multiplier on `1rem` base. Allowed: 0.875 / 1 / 1.125 / 1.25. */
  sizeScale?: FontSizeScale;
}




const _FONT_FAMILY_RE = /^[\p{L}\p{N} ,"'_-]+$/u;
const _FONT_FAMILY_MAX = 200;

export function isValidFontFamilyOverride(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= _FONT_FAMILY_MAX
    && _FONT_FAMILY_RE.test(value);
}
