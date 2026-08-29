import { DEFAULT_SETTINGS } from "../../src/data/settings-defaults.js";
import type { AppSettings, DeepPartial } from "../../src/ui/renderer/types.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(out[key]) ? mergeDeep(out[key], value) : value;
  }
  return out as T;
}

/**
 * A complete renderer settings snapshot: the host defaults minus the main-only
 * `a2aRemote` block (exactly what `lvis:settings:get` answers with), with deep
 * overrides applied. Renderer tests that used to hand-write a partial object
 * typed as the full snapshot start from this instead.
 */
export function fakeAppSettings(overrides: DeepPartial<AppSettings> = {}): AppSettings {
  const { a2aRemote: _mainOnly, ...base } = structuredClone(DEFAULT_SETTINGS);
  return mergeDeep<AppSettings>(base, overrides);
}
