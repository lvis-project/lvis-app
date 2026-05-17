/**
 * #893 — Anonymous in-process counters for host-secret access events.
 *
 * Lightweight surface: no PII, no network, no disk. Lives alongside the
 * existing plugin telemetry client so operators can sample it through the
 * debug console or future inspection IPC without pulling in the marketplace
 * telemetry path. The audit log remains the authoritative record — these
 * counters exist only for at-a-glance aggregation.
 *
 * Keys are `<event>:<pluginId>:<keyPrefix>` and values are monotonic
 * counters. `keyPrefix` is the first `.`-separated segment of the requested
 * key (e.g. `"llm"` for `llm.apiKey.openai`); we intentionally do NOT record
 * the full key so a misconfigured plugin cannot exfiltrate the secret name
 * via the counter snapshot.
 */

export type HostSecretCounterEvent = "hostSecret_read" | "hostSecret_denied";

/**
 * PR #894 review B7 — Known, bounded set of key prefixes the host counter
 * map will accept. An attacker-controlled plugin could otherwise call
 * `hostApi.getSecret("<random>.x")` in a loop and balloon the counter map
 * with one entry per attacker-chosen prefix (memory DoS). Anything outside
 * this set is folded to `"other"` so the cardinality stays O(1).
 *
 * Keep this list narrow: only add a prefix when the host actually issues
 * secret keys in that namespace. Adding a prefix here does NOT grant any
 * new access — the three-tier gate in `plugin-runtime.ts` is still the
 * authority — it only changes how the counter buckets the call.
 */
const KNOWN_PREFIXES = new Set<string>(["llm", "plugin", "marketplace", "web"]);

/**
 * Fold a secret key into a small, bounded prefix bucket. The first
 * `.`-separated segment is returned when it appears in `KNOWN_PREFIXES`,
 * otherwise the constant `"other"`. Keys with no dot fall back to the
 * full key when known, or `"other"` when not.
 */
export function sanitizeKeyPrefix(key: string): string {
  const prefix = key.split(".")[0] ?? "";
  return KNOWN_PREFIXES.has(prefix) ? prefix : "other";
}

const counters = new Map<string, number>();

function counterKey(
  event: HostSecretCounterEvent,
  pluginId: string,
  keyPrefix: string,
): string {
  return `${event}:${pluginId}:${keyPrefix}`;
}

/**
 * Increment the counter for `(event, pluginId, keyPrefix)`. Safe to call
 * before any reader is attached; the counter map is initialized lazily at
 * module load time.
 */
export function incrementHostSecretCounter(
  event: HostSecretCounterEvent,
  pluginId: string,
  keyPrefix: string,
): void {
  const key = counterKey(event, pluginId, keyPrefix);
  counters.set(key, (counters.get(key) ?? 0) + 1);
}

/**
 * Read the current value of a counter. Returns `0` when the counter has
 * never been incremented — callers don't have to distinguish unset from
 * zero.
 */
export function getHostSecretCounter(
  event: HostSecretCounterEvent,
  pluginId: string,
  keyPrefix: string,
): number {
  return counters.get(counterKey(event, pluginId, keyPrefix)) ?? 0;
}

/**
 * Reset every host-secret counter. Test-only helper — production code never
 * needs to clear the in-process counters.
 */
export function resetHostSecretCountersForTesting(): void {
  counters.clear();
}
