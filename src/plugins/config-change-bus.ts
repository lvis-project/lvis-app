import { createLogger } from "../lib/logger.js";
const log = createLogger("plugin-config-change");

/**
 * §9.2 Track B — strictly plugin-scoped config-change emitter.
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
 */

/**
 * Sentinel value passed to `emitPluginConfigChange` (and therefore to
 * `hostApi.config.onChange` listeners) when a secret field is updated.
 *
 * Using a unique Symbol guarantees identity-safe equality checks:
 *   `value === SECRET_REDACTED_SENTINEL` → secret was updated, actual
 *   value is in the keychain, never in the listener payload.
 *
 * Prefer `Symbol.for(...)` so the sentinel is stable across module
 * reloads (e.g. Electron renderer hot-reloads or test re-imports).
 */
export const SECRET_REDACTED_SENTINEL: unique symbol = Symbol.for(
  "lvis.config.secret.redacted",
);

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

/** Test-only: drop every registered listener. */
export function _resetPluginConfigChangeBus(): void {
  listenersByPlugin.clear();
}
