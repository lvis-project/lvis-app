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
