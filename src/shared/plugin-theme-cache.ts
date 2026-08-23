import { BUNDLE_IDS } from "./theme-bundles.js";
import { LVIS_TOKEN_NAMES } from "./plugin-ui-tokens.js";

export type SafeThemePayload = {
  bundleId: string;
  shell: "light" | "dark";
  colorScheme?: "light" | "dark";
  reducedMotion?: boolean;
  tokens?: Record<string, string>;
};

const ALLOWED_BUNDLE_IDS = new Set<string>(BUNDLE_IDS);
const ALLOWED_SHELLS = new Set(["light", "dark"]);
const PLUGIN_TOKEN_NAMES: Set<string> = new Set(LVIS_TOKEN_NAMES);
// Token values the host is allowed to hand a plugin frame, composed from the
// shapes `bundleToPluginTokens` actually emits.
//
// Anything this rejects is dropped silently and the plugin keeps the SDK's
// static fallback for that token — which is a dark-theme value, so a dropped
// token shows up as a dark chip in a light shell rather than as an error. That
// is what a flat `hsl()`-only pattern did to the seven derived tinted tokens
// (`--lvis-*-bg-subtle`, `--lvis-primary-bg-strong`, `--lvis-surface-hover`,
// `--lvis-focus-shadow`): every one is a `color-mix()` string, so every one was
// filtered out of every payload, and the tokens the host added specifically so
// plugins would stop hand-rolling their own mixes never arrived. `hsla()` — the
// input-bar placeholder — was dropped for the same reason.
//
// Composed rather than written flat so widening stays legible: a value is a
// color, a single non-nested `color-mix` of two colors, a length, a font
// weight, or a duration. Nothing else parses, so no `url(...)`, no unbalanced
// text, and no second function call can ride in behind a valid prefix.
const _HSL = String.raw`hsla?\(\s*-?\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?%\s*,\s*\d+(?:\.\d+)?%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)`;
const _HEX = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})`;
const _COLOR = `(?:${_HSL}|${_HEX}|transparent)`;
// String.raw, not a plain template: `\s` and `\d` would otherwise collapse to
// the bare letters and the pattern would match nothing.
const _COLOR_MIX = String.raw`color-mix\(in srgb,\s*${_COLOR}\s+\d+(?:\.\d+)?%\s*,\s*${_COLOR}\s*\)`;
const _LENGTH = String.raw`\d+(?:\.\d+)?(?:rem|em|px|%)`;
const _WEIGHT = String.raw`[1-9]00`;
const _DURATION = String.raw`\d+(?:\.\d+)?ms`;
// The three motion easing tokens; four numbers in 0..1 (the x pair must be, the
// y pair may overshoot, which the bundle's own curves do not).
const _NUM = String.raw`-?\d+(?:\.\d+)?`;
const _EASING = String.raw`cubic-bezier\(\s*${_NUM}\s*,\s*${_NUM}\s*,\s*${_NUM}\s*,\s*${_NUM}\s*\)`;
const SAFE_TOKEN_VALUE = new RegExp(
  `^(?:${_COLOR}|${_COLOR_MIX}|${_LENGTH}|${_WEIGHT}|${_DURATION}|${_EASING})$`,
);

let lastThemePayload: SafeThemePayload | null = null;

/**
 * The last validated host theme is replayed to webviews registered after the
 * renderer's most recent broadcast. It remains null during the short window
 * before the renderer publishes its first theme, when the SDK fallback applies.
 */

export function cloneThemePayload(payload: SafeThemePayload): SafeThemePayload {
  const clone: SafeThemePayload = {
    bundleId: payload.bundleId,
    shell: payload.shell,
  };
  if (payload.colorScheme) clone.colorScheme = payload.colorScheme;
  if (typeof payload.reducedMotion === "boolean") clone.reducedMotion = payload.reducedMotion;
  if (payload.tokens) clone.tokens = Object.freeze({ ...payload.tokens }) as Record<string, string>;
  return Object.freeze(clone);
}

export function getLastThemePayload(): SafeThemePayload | null {
  return lastThemePayload ? cloneThemePayload(lastThemePayload) : null;
}

export function validateThemePayload(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid-payload" };
  const candidate = payload as Record<string, unknown>;
  if (typeof candidate.bundleId !== "string" || !ALLOWED_BUNDLE_IDS.has(candidate.bundleId)) {
    return { ok: false, error: "invalid-bundle-id" };
  }
  if (typeof candidate.shell !== "string" || !ALLOWED_SHELLS.has(candidate.shell)) {
    return { ok: false, error: "invalid-shell" };
  }
  if (!candidate.tokens || typeof candidate.tokens !== "object" || Array.isArray(candidate.tokens)) {
    return { ok: false, error: "missing-tokens" };
  }
  const safe: SafeThemePayload = {
    bundleId: candidate.bundleId,
    shell: candidate.shell as "light" | "dark",
  };
  const safeTokens: Record<string, string> = {};
  for (const [key, value] of Object.entries(candidate.tokens as Record<string, unknown>)) {
    if (PLUGIN_TOKEN_NAMES.has(key) && typeof value === "string" && SAFE_TOKEN_VALUE.test(value)) {
      safeTokens[key] = value;
    }
  }
  safe.tokens = safeTokens;
  // Fonts intentionally remain host-owned. The SDK no longer emits a fonts
  // channel, so an inbound legacy field must not enter the replay cache.
  if (candidate.colorScheme === "light" || candidate.colorScheme === "dark") {
    safe.colorScheme = candidate.colorScheme;
  }
  if (typeof candidate.reducedMotion === "boolean") safe.reducedMotion = candidate.reducedMotion;
  return { ok: true, safe };
}

export function recordValidatedTheme(payload: unknown):
  | { ok: true; safe: SafeThemePayload }
  | { ok: false; error: string } {
  // Validation and cache replacement stay one operation: invalid input never
  // disturbs the last known-good replay payload.
  const result = validateThemePayload(payload);
  if (!result.ok) return result;
  const safe = cloneThemePayload(result.safe);
  lastThemePayload = safe;
  return { ok: true, safe };
}

export function resetLastThemePayloadForTests(): void {
  lastThemePayload = null;
}
