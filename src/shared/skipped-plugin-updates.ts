/**
 * The persisted `settings.marketplace.skippedPluginUpdates` contract — shared
 * between main and renderer.
 *
 * The renderer WRITES the map (the update banner's "skip" action) and main
 * READS it to filter every `marketplace:updates-available` broadcast. The two
 * sides must agree on the key normalization, the reserved-key denylist and the
 * skip predicate, or an update is hidden on one side and shown on the other —
 * or, worse, permanently un-hideable because the writer's key never matches the
 * reader's. Same corrective pattern as `shared/plugin-partition.ts` (#498) and
 * `shared/marketplace-announcements.ts`.
 *
 * Pure — no DOM / Electron / node deps.
 */

/**
 * `pluginId -> the latestVersion the user chose to stop being notified about`.
 *
 * Always null-prototype: the map is keyed by ids read off disk and off the
 * marketplace catalog, so a plain object literal would expose `Object.prototype`
 * members to a bare `skipped[key]` lookup.
 */
export type SkippedPluginUpdateMap = Record<string, string>;

/**
 * Keys that must never enter the map even after trimming — they would either
 * poison the prototype chain or make a lookup answer for an inherited member.
 */
const RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** A fresh, null-prototype map. */
export function createSkippedPluginUpdateMap(): SkippedPluginUpdateMap {
  return Object.create(null) as SkippedPluginUpdateMap;
}

/**
 * The lookup key for a plugin id, or `null` when the id cannot be a key
 * (blank after trimming, or reserved).
 */
export function normalizeSkippedPluginUpdateKey(pluginId: string): string | null {
  const key = pluginId.trim();
  if (!key || RESERVED_SKIPPED_PLUGIN_UPDATE_KEYS.has(key)) return null;
  return key;
}

/**
 * Record one skip. A rejected key or a blank version is dropped silently —
 * an entry that cannot be matched later is worse than no entry.
 */
export function putSkippedPluginUpdate(
  target: SkippedPluginUpdateMap,
  pluginId: string,
  latestVersion: string,
): void {
  const key = normalizeSkippedPluginUpdateKey(pluginId);
  const value = latestVersion.trim();
  if (!key || !value) return;
  target[key] = value;
}

/**
 * Read an untrusted persisted value into a normalized map. Anything that is not
 * a plain object yields an empty map; non-string values, unusable keys and blank
 * versions are dropped.
 *
 * Idempotent, so it doubles as the copy operation for an already-normalized map.
 */
export function readSkippedPluginUpdates(input: unknown): SkippedPluginUpdateMap {
  const result = createSkippedPluginUpdateMap();
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [pluginId, version] of Object.entries(input)) {
    if (typeof version !== "string") continue;
    putSkippedPluginUpdate(result, pluginId, version);
  }
  return result;
}

/**
 * Whether this pending update is one the user already chose to skip — true only
 * for an exact match on the same `latestVersion`, so a newer release re-notifies.
 */
export function isSkippedPluginUpdate(
  update: { pluginId: string; latestVersion: string },
  skipped: SkippedPluginUpdateMap,
): boolean {
  const key = normalizeSkippedPluginUpdateKey(update.pluginId);
  const version = update.latestVersion.trim();
  return Boolean(key && version && skipped[key] === version);
}
