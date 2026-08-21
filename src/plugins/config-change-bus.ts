import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-config-change");

/**
 * §9.2 — strictly plugin-scoped config-change emitter.
 *
 * Backs `hostApi.config.onChange()`. Listeners are keyed by `pluginId`
 * so plugin A can NEVER observe plugin B's config writes — the IPC
 * `setPluginConfig` handler emits exactly one change event for the
 * affected pluginId, and listeners registered by other plugins are
 * never even reachable from that branch of the code.
 *
 * Single-process, in-memory bus — config-change events are not crossing
 * the renderer boundary today (the typed `PluginConfigTab` writes go
 * through IPC and trigger a host-side reload, after which plugin
 * handlers see the new values on next call).
 *
 * ## Secret sentinel
 *
 * When a secret field is updated via `lvis:plugins:config:secret:set`, the
 * actual secret value is written to the encrypted keychain and NEVER passed
 * to listeners. Instead, `emitPluginConfigChange` receives
 * `SECRET_REDACTED_SENTINEL` as the value. Listeners can reliably distinguish
 * "secret was changed (value masked)" from same-value transitions by checking
 * `value === SECRET_REDACTED_SENTINEL` — unlike the old `"[REDACTED]"` string,
 * a Symbol identity check cannot produce false positives.
 *
 * Usage:
 * ```ts
 * import { SECRET_REDACTED_SENTINEL } from "./config-change-bus.js";
 *
 * hostApi.config.onChange("apiKey", (key, value) => {
 *   if (value === SECRET_REDACTED_SENTINEL) {
 *     // Secret was saved — reload using hostApi.getSecret()
 *   } else {
 *     // Normal cleartext value change
 *   }
 * });
 * ```
 *
 * The sentinel itself is DECLARED in `isolation/host-api-wire.ts`
 * and re-exported here. This module builds a pino logger at import, pino writes
 * to fd 1, and fd 1 in a plugin child is the framed protocol — so the one value
 * both processes need could not be declared next to a stdout writer. See that
 * file for the full reasoning; the re-export keeps this module the doorway the
 * emit site and this documentation already point at.
 */
export { SECRET_REDACTED_SENTINEL } from "./isolation/host-api-wire.js";

type ConfigChangeListener = (key: string, value: unknown) => void;

interface PluginListenerRecord {
  /** key → set of listeners. `*` matches every key for this plugin. */
  byKey: Map<string, Set<ConfigChangeListener>>;
}

const listenersByPlugin = new Map<string, PluginListenerRecord>();

function getOrCreatePluginRecord(pluginId: string): PluginListenerRecord {
  let rec = listenersByPlugin.get(pluginId);
  if (!rec) {
    rec = { byKey: new Map() };
    listenersByPlugin.set(pluginId, rec);
  }
  return rec;
}

/**
 * Register a listener for a given plugin's config key. Returns an
 * unsubscribe disposer. The subscription is scoped to `pluginId` —
 * listeners registered for plugin A are never invoked when plugin B's
 * config changes.
 */
export function subscribePluginConfigChange(
  pluginId: string,
  key: string,
  listener: ConfigChangeListener,
): () => void {
  const rec = getOrCreatePluginRecord(pluginId);
  let set = rec.byKey.get(key);
  if (!set) {
    set = new Set();
    rec.byKey.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = listenersByPlugin.get(pluginId);
    if (!current) return;
    const bucket = current.byKey.get(key);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) current.byKey.delete(key);
    if (current.byKey.size === 0) listenersByPlugin.delete(pluginId);
  };
}

/**
 * Emit a config-change event for one plugin. The IPC `setPluginConfig`
 * handler calls this once per saved key (or once with `key === "*"` for
 * a full overwrite). Listeners registered for OTHER pluginIds are
 * unreachable from this code path and therefore guaranteed not to fire.
 */
export function emitPluginConfigChange(
  pluginId: string,
  key: string,
  value: unknown,
): void {
  const rec = listenersByPlugin.get(pluginId);
  if (!rec) return;
  const bucket = rec.byKey.get(key);
  if (bucket) {
    for (const listener of bucket) {
      try {
        listener(key, value);
      } catch (err) {
        // eslint-disable-next-line no-console
        log.warn(
          `listener failed for plugin=${pluginId} key=${key}: %s`,
          (err as Error).message,
        );
      }
    }
  }
  // `*` wildcard listeners observe every key for this plugin.
  const wildcardBucket = rec.byKey.get("*");
  if (wildcardBucket) {
    for (const listener of wildcardBucket) {
      try {
        listener(key, value);
      } catch (err) {
        // eslint-disable-next-line no-console
        log.warn(
          `wildcard listener failed for plugin=${pluginId} key=${key}: %s`,
          (err as Error).message,
        );
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Host public preferences — the OTHER config value a plugin reads.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Listeners for "an allow-listed host preference changed".
 *
 * WHY THIS SIGNAL EXISTS. `hostApi.getAppPreference(key)` is SYNCHRONOUS, so an
 * out-of-process plugin cannot answer it with a round trip — §3.1 answers such
 * members from a host-pushed snapshot instead. A snapshot is only correct while
 * something re-pushes it, and `hostApi` exposed nothing to re-push from: the
 * in-process member reads `settingsService` live on every call, so an isolated
 * plugin would have answered with the value the preference held when it
 * started, forever, with nothing reporting the divergence. That is why
 * `getAppPreference` was the one member the child left unwired.
 *
 * VALUE-FREE ON PURPOSE, exactly like `onPluginsChanged`. A listener re-reads
 * through `getAppPreference`, which is the same reader the in-process member
 * uses, so there is ONE authority for what a preference is rather than a second
 * one assembled out of change events.
 *
 * WHY HERE AND NOT BESIDE THE READER. This module is already the doorway for
 * "a config value a plugin reads has moved" — `subscribePluginConfigChange`
 * above, and the sentinel re-export this file's header documents to plugin
 * authors. A second such doorway in `boot/steps/` would mean a reader looking
 * for the signal has two files to know about instead of one.
 *
 * NOT A DEPENDENCY-DIRECTION ARGUMENT, and one would be false here:
 * `out-of-process-plugin.ts` — the plugins-layer module that subscribes below —
 * imports `HOST_PUBLIC_PREFERENCE_KEYS` straight out of that boot step, because
 * a second copy of the allowlist would be a second answer to a security
 * question. The layers already run that way; this placement is about where the
 * signal is FOUND, not about which module may import which.
 */
type AppPreferenceChangeListener = () => void;

const appPreferenceListeners = new Set<AppPreferenceChangeListener>();

/**
 * Register a listener for host public preference changes. Returns a disposer.
 *
 * Not plugin-scoped, and that is the difference from the bus above: a host
 * preference belongs to the app, not to a plugin, so every listener sees every
 * change. The allowlist — not this bus — is what keeps host-private settings
 * out of a plugin's reach (`boot/steps/plugin-runtime/app-preference.ts`).
 */
export function subscribeAppPreferenceChange(
  listener: AppPreferenceChangeListener,
): () => void {
  appPreferenceListeners.add(listener);
  return () => {
    appPreferenceListeners.delete(listener);
  };
}

/**
 * Announce that at least one allow-listed host preference now reads differently.
 *
 * The CALLER decides that: `publishAppPreferenceChange` in
 * `boot/steps/plugin-runtime/app-preference.ts` compares the allow-listed
 * values against the last published set and calls this only when they moved, so
 * a settings save that touched nothing a plugin can read pushes nothing.
 */
export function emitAppPreferenceChange(): void {
  for (const listener of appPreferenceListeners) {
    try {
      listener();
    } catch (err) {
      log.warn(
        `app-preference listener failed: %s`,
        (err as Error).message,
      );
    }
  }
}

/** Test-only: drop every registered listener. */
export function _resetPluginConfigChangeBus(): void {
  listenersByPlugin.clear();
  appPreferenceListeners.clear();
}
