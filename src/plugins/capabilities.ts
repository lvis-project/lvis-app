/**
 * Capability policy + event namespace allowlist.
 *
 * Two concerns:
 *  1. `KNOWN_CAPABILITIES` — closed vocabulary for manifest.capabilities[].
 *     Unknown entries fail schema validation so typos do not silently
 *     "grant" nothing.
 *  2. `PUBLIC_EVENT_NAMESPACES` / `PLUGIN_PRIVATE_NAMESPACES` — restrict
 *     which host events a plugin may subscribe to and emit.
 *
 * Sources of truth re-exported for plugin-development docs — do not fork.
 */

/**
 * Closed vocabulary of capability strings accepted in manifest.capabilities[].
 *
 * Declared as a `const` tuple so it backs BOTH the runtime membership set
 * (`KNOWN_CAPABILITIES`) and the compile-time {@link CapabilityId} union. The
 * host-consumed id constants below are typed to that union, so a typo in a
 * host-side capability gate is a `tsc` error instead of a silent gate against
 * an id no manifest can ever declare.
 */
export const KNOWN_CAPABILITY_IDS = [
  "ms-graph-consumer",
  "external-auth-consumer",
  "mail-source",
  "calendar-source",
  "routine-provider",
  "meeting-recorder",
  "knowledge-index",
  "background-watcher",
  "worker-client",
  "document-indexer",
  "lifecycle-observer",
  // host:overlay — plugin may call triggerConversation() as overlay runner.
  // triggerConversation() now routes to OverlayContext staging instead of spawning
  // a fresh ConversationLoop. Capability gates the same method as before.
  "host:overlay",
] as const;

/** Compile-time union of every valid capability id (typo-safety for gates). */
export type CapabilityId = (typeof KNOWN_CAPABILITY_IDS)[number];

/** Closed set of capability strings accepted in manifest.capabilities[]. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set(KNOWN_CAPABILITY_IDS);

/**
 * Capability ids CONSUMED by host-internal capability gates. Every host-side
 * gate references one of these named constants instead of an inline string
 * literal, so all gate sites share a single typo-safe source for the id.
 *
 * These are NOT a re-introduction of the deleted `ENFORCED_CAPABILITIES` map:
 * they carry NO enforcement policy (which method is gated, fail-closed vs
 * fail-open), only the id string itself. Enforcement logic stays inline at each
 * gate. Typed as {@link CapabilityId}, so any drift from KNOWN_CAPABILITY_IDS
 * is a compile error.
 */
export const CAPABILITY_EXTERNAL_AUTH_CONSUMER: CapabilityId = "external-auth-consumer";
export const CAPABILITY_HOST_OVERLAY: CapabilityId = "host:overlay";

/**
 * Map of event namespace prefix → capability required to EMIT events in that
 * namespace. Plugins without the capability have their emissions dropped
 * (log.warn + no fan-out).
 *
 * `task` namespace is absent — host-side TaskDeadlinePoller and TaskService
 * were removed in 2026-05. Task ownership now lives in plugins.
 * Plugin-owned namespaces (single publisher pinned by HostApi pluginId
 * identity) are intentionally NOT capability-gated here — host stays
 * agnostic to plugin ids (open-source-readiness). Plugin-bus event
 * subscribers receive a load-time namespace-drift warn instead, treated
 * as informational.
 */
export const EVENT_NAMESPACE_CAPABILITY: ReadonlyMap<string, string> = new Map([
  ["email", "mail-source"],
  ["calendar", "calendar-source"],
  ["meeting", "meeting-recorder"],
  ["index", "knowledge-index"],
]);

/**
 * Event namespaces reserved for HOST emission — plugins MUST NOT emit these
 * via `hostApi.emitEvent()` regardless of declared capabilities. The host's
 * boot event bus (`emitEvent` in `boot/types.ts`) bypasses this gate, so
 * legitimate host-side emit (e.g. `plugin.installed` from `ipc/domains/plugins.ts`)
 * still works.
 *
 * Why this is separate from `EVENT_NAMESPACE_CAPABILITY`: capability-based
 * gating lets a plugin emit *its own* events (mail-source plugin emits
 * `email.new`). Host-only namespaces have no legitimate plugin-side emitter
 * — letting any plugin spoof `plugin.installed` (or in future `host.*`)
 * would let one plugin trick lifecycle subscribers into reacting to fake
 * install/uninstall events.
 */
export const HOST_ONLY_EMIT_NAMESPACES: ReadonlySet<string> = new Set([
  "plugin",
  "host",
]);

/**
 * Event namespaces a plugin is ALLOWED to subscribe to (via
 * manifest.eventSubscriptions). Anything outside this list is not explicitly
 * published for plugin consumption; subscriptions are allowed with a warn
 * (namespace drift tracking) unless it falls under PLUGIN_PRIVATE_NAMESPACES.
 *
 * `task.*` was retired here on 2026-05-11 — host-side owner was
 * removed in 2026-05-05 (architecture.md §"task-deadline"
 * row). No plugin emits the namespace today; task-domain signals flow
 * through a plugin-owned channel instead. That plugin-owned channel
 * is intentionally NOT promoted into this allowlist: the host stays
 * agnostic to plugin ids (open-source-readiness — keep plugin
 * specifics in plugins, not host source), and cross-plugin subscribers
 * pay a one-line load-time namespace-drift warn that is treated as
 * informational rather than an error.
 */
export const PUBLIC_EVENT_NAMESPACES: ReadonlySet<string> = new Set([
  "meeting",
  "calendar",
  "email",
  "index",
]);

/**
 * Exact host-owned event names that are intentionally available to plugins.
 * Keep this exact-name allowlist separate from PUBLIC_EVENT_NAMESPACES so
 * `host.*` remains blocked for plugin emits and future host internals do not
 * become silently subscribable by namespace.
 */
export const PUBLIC_HOST_EVENT_TYPES: ReadonlySet<string> = new Set([
  "host.theme.changed",
]);

/**
 * Event namespaces a plugin must NEVER subscribe to — they carry sensitive
 * host state (memory contents, secrets, audit trails, DLP decisions).
 * Subscriptions to these prefixes are rejected at wiring time.
 */
export const PLUGIN_PRIVATE_NAMESPACES: ReadonlySet<string> = new Set([
  "memory.private",
  "settings.apiKey",
  "audit",
  "dlp",
]);

/**
 * Categorize an event type by its namespace prefix.
 * Returns the prefix when it is a known public namespace, otherwise "other".
 * Single source of truth — replaces ad-hoc prefix splits in older host wiring
 * and boot/plugins.
 */
export function categorizeEvent(eventType: string): string {
  if (PUBLIC_HOST_EVENT_TYPES.has(eventType)) return "host";
  const prefix = eventType.split(".")[0] ?? "";
  return PUBLIC_EVENT_NAMESPACES.has(prefix) ? prefix : "other";
}

/**
 * Returns the capability required to emit an event of this type, or
 * undefined when the namespace is not gated.
 */
export function requiredCapabilityForEmit(eventType: string): string | undefined {
  const prefix = eventType.split(".")[0] ?? "";
  return EVENT_NAMESPACE_CAPABILITY.get(prefix);
}

/**
 * Pure capability-gating predicate for event emission.
 *
 * Returns true when the plugin is allowed to emit `eventType`; false when the
 * event namespace requires a capability the plugin does not declare.
 *
 * Extracted as a standalone function so both the production `createHostApi`
 * and unit tests can import and verify the same logic rather than each
 * implementing their own guard.
 */
export function canEmitEvent(
  eventType: string,
  capabilities: readonly string[],
): boolean {
  const prefix = eventType.split(".")[0] ?? "";
  if (HOST_ONLY_EMIT_NAMESPACES.has(prefix)) return false;
  const requiredCap = requiredCapabilityForEmit(eventType);
  if (!requiredCap) return true;
  return capabilities.includes(requiredCap);
}

/**
 * Classify a subscription target:
 * - "private": reject (matches PLUGIN_PRIVATE_NAMESPACES).
 * - "public":  allow silently (matches PUBLIC_EVENT_NAMESPACES).
 * - "neutral": allow with warn (everything else — namespace drift signal).
 */
export function classifySubscription(
  eventType: string,
): "private" | "public" | "neutral" {
  // Private namespaces can be dotted (memory.private.*, settings.apiKey.*) so
  // longest-prefix match wins.
  for (const priv of PLUGIN_PRIVATE_NAMESPACES) {
    if (eventType === priv || eventType.startsWith(`${priv}.`)) {
      return "private";
    }
  }
  if (PUBLIC_HOST_EVENT_TYPES.has(eventType)) return "public";
  const prefix = eventType.split(".")[0] ?? "";
  if (PUBLIC_EVENT_NAMESPACES.has(prefix)) return "public";
  return "neutral";
}
