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
 */

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
        console.warn(
          `[plugin-config-change] listener failed for plugin=${pluginId} key=${key}:`,
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
        console.warn(
          `[plugin-config-change] wildcard listener failed for plugin=${pluginId} key=${key}:`,
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
