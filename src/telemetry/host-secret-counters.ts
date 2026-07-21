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

export type HostSecretCounterEvent =
  | "hostSecret_read"
  | "hostSecret_denied"
  // #958 round-1 security MEDIUM — separate counter for admin-install
  // Tier-3 bypass events so anomaly detection can spot an unexpected
  // burst of admin-bypass reads (e.g. a runaway plugin, or one whose
  // installSource was upgraded without operator awareness). Bucketed
  // by the same `(pluginId, keyPrefix)` tuple as the other host-secret
  // counters; `hostSecret_read` is still incremented on top so totals
  // remain comparable.
  | "hostSecret_admin_bypass"
  // #893 Stage 2 — whitelist registry observability. Bucketed under the same
  // counter map so operators see allow / deny / whitelist-fetch state in a
  // single inspection. `pluginId` = "boot" for registry-wide events; the
  // `keyPrefix` slot holds the reason/source bucket (e.g. "network",
  // "primary", "monotonicity").
  | "whitelist_fetch_ok"
  | "whitelist_fetch_failed"
  | "whitelist_cache_hit"
  | "whitelist_cache_stale"
  | "whitelist_cache_miss_offline"
  // Tier A — plugin egress observability for `hostApi.hostFetch`. Bucketed by
  // `(pluginId, reason)` so operators can spot an unexpected egress burst or a
  // plugin repeatedly tripping deny-by-default. `hostFetch_egress` uses the
  // fixed `"egress"` bucket; `hostFetch_denied` uses the denial-reason bucket
  // (`capability` / `invalid-url` / `non-https` / `not-allowlisted` /
  // `malformed-allowlist`). The audit log (`host_fetch` / `host_fetch_denied`)
  // remains the authoritative record — these counters are at-a-glance only.
  | "hostFetch_egress"
  | "hostFetch_denied";

/**
 * #893 — `hostSecret_denied` denial taxonomy. Recorded into the audit log
 * (free-form text) alongside the counter increment so operators can pivot
 * on specific reasons. The bucket key in `counters` stays one of
 * `HostSecretCounterEvent` to keep cardinality bounded — the reason is a
 * free-form audit-only tag, not a Map index.
 */
export type HostSecretDeniedReason =
  | "not-allowlisted"
  | "non-active-vendor"
  | "not-whitelisted"
  | "manifest-sha-mismatch"
  | "whitelist-unreachable"
  | "whitelist-stale-exceeded";

/**
 * PR #894 review B7 — Known, bounded set of key prefixes the host counter
 * map will accept. An attacker-controlled plugin could otherwise call
 * `hostApi.getSecret("<random>.x")` in a loop and balloon the counter map
 * with one entry per attacker-chosen prefix (memory DoS). Anything outside
 * this set is folded to `"other"` so the cardinality stays O(1).
 *
 * Keep this list narrow. It is the bounded bucket allowlist for ALL counter
 * dimensions, not just secret namespaces — secret-key prefixes (`llm`,
 * `plugin`, …), whitelist-registry reason buckets, and Tier A plugin-egress
 * reason buckets (`egress`, `capability`, …) all live here so the counter map
 * stays O(1). Adding a bucket here does NOT grant any access — the gates in
 * `plugin-runtime.ts` remain the authority — it only changes how the counter
 * buckets the call. Anything not listed folds to `"other"`.
 */
const KNOWN_PREFIXES = new Set<string>([
  "llm",
  "plugin",
  "marketplace",
  "web",
  // #893 Stage 2 — whitelist registry buckets ("primary" / "fallback" /
  // "network" / "monotonicity" / "no-cache" / etc.). Keeping the bucket
  // names in this allowlist preserves the O(1) cardinality guard while
  // making the registry's per-reason counters readable in inspections.
  "primary",
  "fallback",
  "network",
  "signature_invalid",
  "monotonicity",
  "no-cache",
  "corrupt",
  "cache",
  "default",
  // Tier A plugin-egress buckets (hostFetch_egress / hostFetch_denied).
  "egress",
  "capability",
  "invalid-url",
  "non-https",
  "not-allowlisted",
  "malformed-allowlist",
]);

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
