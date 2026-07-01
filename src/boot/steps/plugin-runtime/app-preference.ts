/**
 * Boot §4.2 / §B3 — host public preference reader.
 *
 * Extracted from `plugin-runtime.ts` (C5, behavior-preserving). Owns the
 * explicit allowlist of host preference keys readable by plugins via
 * `hostApi.getAppPreference(key)` and the reader closure factory.
 */
import type { SettingsService } from "../../../data/settings-store.js";

/**
 * §B3 — Explicit allowlist of host preference keys readable by plugins via
 * `hostApi.getAppPreference(key)`. Adding a new entry is a deliberate API
 * surface change: it must be reviewed for "does this leak host-private
 * state?" (secrets, auth tokens, plugin configs all stay OFF this list).
 *
 * Reader logic in `buildAppPreferenceReader()` must be updated in lockstep —
 * a key on this list with no reader returns `undefined` (safe failure).
 */
export const HOST_PUBLIC_PREFERENCE_KEYS = [
  "webView.preferredFlow",
] as const;

export type HostPublicPreferenceKey = (typeof HOST_PUBLIC_PREFERENCE_KEYS)[number];

function isHostPublicPreferenceKey(key: string): key is HostPublicPreferenceKey {
  return (HOST_PUBLIC_PREFERENCE_KEYS as readonly string[]).includes(key);
}

/**
 * §B3 — Build the reader closure used by every plugin's
 * `hostApi.getAppPreference`. Reads run live against `settingsService` so a
 * settings toggle is visible on the next call.
 *
 * Per-plugin warn dedupe: at most one warn line per (pluginId, key) per
 * runtime — prevents log floods when a plugin polls a denied key.
 */
export function buildAppPreferenceReader(
  settingsService: SettingsService,
  warnLogger: { warn: (msg: string) => void },
): (pluginId: string, key: string) => unknown {
  const warnedPerPlugin = new Map<string, Set<string>>();
  const recordWarn = (pluginId: string, key: string) => {
    let set = warnedPerPlugin.get(pluginId);
    if (!set) {
      set = new Set();
      warnedPerPlugin.set(pluginId, set);
    }
    if (set.has(key)) return false;
    set.add(key);
    return true;
  };

  return (pluginId, key) => {
    if (typeof key !== "string" || key.length === 0) {
      if (recordWarn(pluginId, String(key))) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: invalid key`,
        );
      }
      return undefined;
    }
    if (!isHostPublicPreferenceKey(key)) {
      if (recordWarn(pluginId, key)) {
        warnLogger.warn(
          `plugin:${pluginId} getAppPreference: key not on host public allowlist key=${key}`,
        );
      }
      return undefined;
    }
    switch (key) {
      case "webView.preferredFlow":
        return settingsService.get("webView")?.preferredFlow;
      default: {
        // Exhaustiveness: if a key is added to HOST_PUBLIC_PREFERENCE_KEYS but
        // not wired here, fall through and warn so it's caught in tests.
        const _exhaustive: never = key;
        void _exhaustive;
        return undefined;
      }
    }
  };
}
