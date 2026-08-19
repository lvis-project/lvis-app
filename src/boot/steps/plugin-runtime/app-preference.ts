/**
 * Boot §4.2 / §B3 — host public preference reader, and the signal that says it
 * moved.
 *
 * Owns the explicit allowlist of host preference keys readable by plugins via
 * `hostApi.getAppPreference(key)`, the reader closure factory, and the
 * publisher that turns a settings save into a change announcement on the
 * plugin-config bus.
 *
 * WHY A PUBLISHER LIVES WITH THE READER. `getAppPreference` is synchronous, so
 * an out-of-process plugin answers it from a host-pushed snapshot rather than a
 * round trip — and a snapshot with no change signal is a value frozen at plugin
 * start. Deciding "did anything a plugin can read actually change" needs the
 * allowlist and the reader, both of which are here; announcing it needs only a
 * listener set, which is in `plugins/config-change-bus.ts`. Split along that
 * line, the settings domain calls ONE function and neither half re-derives the
 * other's knowledge.
 */
import { emitAppPreferenceChange } from "../../../plugins/config-change-bus.js";
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
 * Read ONE allow-listed preference from live settings.
 *
 * The single reader arm. `buildAppPreferenceReader` (what a plugin calls) and
 * `publishAppPreferenceChange` (what decides a change happened) both go through
 * it, so "what a plugin sees" and "what counts as a change" can never be two
 * different answers. The exhaustiveness check keeps it in lockstep with the
 * allowlist: adding a key without an arm here does not compile.
 */
function readHostPublicPreference(
  settingsService: SettingsService,
  key: HostPublicPreferenceKey,
): unknown {
  switch (key) {
    case "webView.preferredFlow":
      return settingsService.get("webView")?.preferredFlow;
    default: {
      const _exhaustive: never = key;
      void _exhaustive;
      return undefined;
    }
  }
}

/**
 * The last set of values this module announced, as a stable signature.
 *
 * `undefined` until the first publish, which is why the first call after boot
 * always announces: the publisher is only ever called AFTER a settings write
 * committed, so "we have never looked" and "it changed" want the same outcome —
 * a push. Treating the first observation as a silent baseline instead would
 * drop exactly the first preference edit of a session.
 */
let lastPublishedPreferenceSignature: string | undefined;

/**
 * Announce a host public preference change, if there is one.
 *
 * Called from the settings domain wherever a settings mutation is broadcast.
 * It compares the allow-listed values against the last announced set and emits
 * only on a real move, so the many settings saves that touch nothing a plugin
 * can read (theme, model, shortcuts) push nothing across a process boundary.
 *
 * The signature is built by iterating the allowlist IN ORDER, so it does not
 * depend on object key ordering, and `null` stands in for an unset key —
 * `JSON.stringify` would drop an `undefined` property and make "cleared" look
 * identical to "unchanged".
 */
export function publishAppPreferenceChange(settingsService: SettingsService): void {
  const signature = JSON.stringify(
    HOST_PUBLIC_PREFERENCE_KEYS.map((key) => {
      const value = readHostPublicPreference(settingsService, key);
      return [key, value === undefined ? null : value];
    }),
  );
  if (signature === lastPublishedPreferenceSignature) return;
  lastPublishedPreferenceSignature = signature;
  emitAppPreferenceChange();
}

/** Test-only: forget what was last announced, so a suite starts from boot state. */
export function _resetAppPreferencePublisher(): void {
  lastPublishedPreferenceSignature = undefined;
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
    return readHostPublicPreference(settingsService, key);
  };
}
