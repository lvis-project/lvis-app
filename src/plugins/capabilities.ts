/**
 * Capability policy + event namespace allowlist.
 *
 * Two concerns:
 *  1. `KNOWN_CAPABILITIES` — the closed set of capability strings the host
 *     ENFORCES at runtime (external-auth-consumer, host:overlay). The manifest
 *     schema accepts any format-valid string (NOT an enum), so legacy/unknown
 *     capability strings on already-installed manifests still validate and load
 *     as harmless no-ops (see the reduction note on KNOWN_CAPABILITY_IDS below).
 *  2. `PUBLIC_EVENT_NAMESPACES` / `PLUGIN_PRIVATE_NAMESPACES` — restrict
 *     which host events a plugin may subscribe to and emit.
 *
 * Sources of truth re-exported for plugin-development docs — do not fork.
 */

/**
 * The closed set of capability strings the host ENFORCES at runtime.
 *
 * Capabilities reduction (Ph1/Ph2) narrowed this from a 12-string vocabulary to
 * the two the host actually gates on:
 *  - 5 DEAD strings (ms-graph-consumer, background-watcher, document-indexer,
 *    lifecycle-observer, routine-provider) had zero read sites and were removed.
 *  - 4 event-source strings (mail-source, calendar-source, meeting-recorder,
 *    knowledge-index) are no longer author-declared — emit authorization is now
 *    INFERRED from the plugin's `emittedEvents` namespace ({@link canEmitEvent}).
 *    They survive only as internal effect labels in EVENT_NAMESPACE_CAPABILITY.
 *  - `worker-client` is NOT dead: it is a live host discovery key
 *    (`findPluginIdByCapability` in boot/tools.ts wires knowledge tools to the
 *    local-indexer). But it is matched as a plain declared string, not a
 *    host-enforced gate, so it is not in this enforced set. It — like any legacy
 *    capability string — remains a valid free-form manifest declaration.
 *
 * The manifest schema (`schemas/plugin-manifest.schema.json`) NO LONGER mirrors
 * this as an enum: it accepts any format-valid string so an installed manifest
 * declaring a removed/legacy string still validates and loads rather than being
 * rejected. This const still backs BOTH the runtime membership set
 * (`KNOWN_CAPABILITIES`) and the compile-time {@link CapabilityId} union, so a
 * typo in one of the host's own enforced-capability gates is a `tsc` error.
 */
export const KNOWN_CAPABILITY_IDS = [
  "external-auth-consumer",
  // host:overlay — plugin may call triggerConversation() as overlay runner.
  // triggerConversation() routes to OverlayContext staging instead of spawning
  // a fresh ConversationLoop. Capability gates the same method (trigger-gate.ts).
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
 * Map of gated event-namespace prefix → the internal effect LABEL for emitting
 * in that namespace.
 *
 * This is NO LONGER an author-declared capability: a plugin authorizes itself
 * to emit `email.*` by DECLARING an `email.*` entry in `emittedEvents`
 * ({@link canEmitEvent}), not by listing `mail-source` in `capabilities`. The
 * label survives only as (a) the gated-namespace detector
 * ({@link requiredCapabilityForEmit}) and (b) the `required=` field of the
 * emit-denied audit trail. A prefix present here means "gated"; absent means
 * "freely emittable".
 *
 * `task` namespace is absent — host-side TaskDeadlinePoller and TaskService
 * were removed in 2026-05. Task ownership now lives in plugins.
 * Plugin-owned namespaces (single publisher pinned by HostApi pluginId
 * identity) are intentionally NOT gated here — host stays agnostic to plugin
 * ids (open-source-readiness). Plugin-bus event subscribers receive a
 * load-time namespace-drift warn instead, treated as informational.
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
 * Returns the internal effect label for emitting an event of this type, or
 * undefined when the namespace is not gated. Used to detect gated namespaces
 * and to label the emit-denied audit trail — this is NOT an author-declarable
 * capability (authorization is inferred from `emittedEvents`, see
 * {@link canEmitEvent}).
 */
export function requiredCapabilityForEmit(eventType: string): string | undefined {
  const prefix = eventType.split(".")[0] ?? "";
  return EVENT_NAMESPACE_CAPABILITY.get(prefix);
}

/**
 * Pure gating predicate for plugin event emission.
 *
 * Returns true when the plugin may emit `eventType`; false when the namespace
 * is host-reserved, or is a gated event-source namespace the plugin has not
 * DECLARED in `emittedEvents`.
 *
 * Emit authorization for the gated namespaces (email/calendar/meeting/index) is
 * INFERRED from the plugin's declared `emittedEvents`: a plugin declaring
 * `emittedEvents: ["email.new"]` may emit any `email.*` WITHOUT a separate
 * `mail-source` capability. The security property is preserved and fail-closed:
 * a plugin may only emit in a gated namespace it declared; an undeclared gated
 * namespace is suppressed. Non-gated namespaces stay freely emittable (trust
 * comes from the HostApi pluginId binding + the owner gate in
 * `assertPluginEventEmitAccess`); host-reserved namespaces are always denied.
 *
 * Extracted as a standalone function so both production emit paths
 * (`createHostApi` + the plugin-webview IPC bridge) and unit tests verify the
 * same logic rather than each implementing their own guard.
 */
export function canEmitEvent(
  eventType: string,
  emittedEvents: readonly string[],
): boolean {
  const prefix = eventType.split(".")[0] ?? "";
  if (HOST_ONLY_EMIT_NAMESPACES.has(prefix)) return false;
  if (classifySubscription(eventType) === "private") return false;
  if (!requiredCapabilityForEmit(eventType)) return true;
  // Gated event-source namespace — the plugin must have DECLARED an event in
  // this namespace via emittedEvents (its namespace declaration replaces the
  // previously-required capability declaration).
  return emittedEvents.some((e) => (e.split(".")[0] ?? "") === prefix);
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
