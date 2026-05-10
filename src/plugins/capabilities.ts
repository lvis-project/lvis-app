/**
 * Capability policy + event namespace allowlist.
 *
 * Two concerns:
 *  1. `KNOWN_CAPABILITIES` — closed vocabulary for manifest.capabilities[].
 *     Unknown entries fail schema validation so typos do not silently
 *     "grant" nothing. `ENFORCED_CAPABILITIES` records which capabilities
 *     are currently gated at runtime vs merely advisory.
 *  2. `PUBLIC_EVENT_NAMESPACES` / `PLUGIN_PRIVATE_NAMESPACES` — restrict
 *     which host events a plugin may subscribe to and emit.
 *
 * Sources of truth re-exported for plugin-development docs — do not fork.
 */

/**
 * Capability status summary used by host policy and governance docs.
 *
 * - `enforced`: runtime check exists (HostApi method refuses / event dropped
 *   when capability is missing).
 * - `advisory`: declared in manifests today but not enforced at runtime.
 *   Tracked so ops can audit plugin intent; future phases may harden.
 */
export type CapabilityEnforcement = "enforced" | "advisory";

export interface CapabilityPolicy {
  /** Short human-readable description (shown in audit output). */
  description: string;
  /** enforced = runtime gate active; advisory = declared but not blocking. */
  enforcement: CapabilityEnforcement;
  /**
   * HostApi method names or event namespace prefixes gated by this
   * capability. Empty when the capability is purely advisory.
   */
  gates: string[];
}

/** Closed set of capability strings accepted in manifest.capabilities[]. */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
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
  // SDK schema still recognizes this token for manifest validation parity,
  // but runtime gating for triggerConversation is `host:overlay` only.
  "conversation-trigger",
  "lifecycle-observer",
  // host:overlay — plugin may call triggerConversation() as overlay runner.
  // triggerConversation() now routes to OverlayContext staging instead of spawning
  // a fresh ConversationLoop. Capability gates the same method as before.
  "host:overlay",
]);

/**
 * Runtime enforcement policy per capability. Keys mirror KNOWN_CAPABILITIES;
 * `enforcement=advisory` entries carry empty `gates` by convention.
 */
export const ENFORCED_CAPABILITIES: ReadonlyMap<string, CapabilityPolicy> = new Map([
  [
    "ms-graph-consumer",
    {
      description:
        "Self-identification label for plugins that consume Microsoft Graph. Host-side provider-auth HostApi methods are not part of the app contract, so this capability is advisory only.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "external-auth-consumer",
    {
      description:
        "Required to open interactive login BrowserWindows and harvest cookies via openAuthWindow. Gated because this spawns a real Chromium window and exposes session cookies to the plugin.",
      enforcement: "enforced",
      gates: ["openAuthWindow"],
    },
  ],
  [
    "mail-source",
    {
      description: "Required to emit host events under the email.* namespace.",
      enforcement: "enforced",
      gates: ["event:email.*"],
    },
  ],
  [
    "calendar-source",
    {
      description: "Required to emit host events under the calendar.* namespace.",
      enforcement: "enforced",
      gates: ["event:calendar.*"],
    },
  ],
  [
    "routine-provider",
    {
      description:
        "Advisory — signals the plugin provides routine execution tools (wakeup, schedule, shutdown) consumable by the host Routine runtime.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "meeting-recorder",
    {
      description: "Required to emit host events under the meeting.* namespace.",
      enforcement: "enforced",
      gates: ["event:meeting.*"],
    },
  ],
  [
    "knowledge-index",
    {
      description: "Required to emit host events under the index.* namespace.",
      enforcement: "enforced",
      gates: ["event:index.*"],
    },
  ],
  [
    "background-watcher",
    {
      description:
        "Advisory — signals the plugin boots long-running pollers/watchers via startupTools. Not gated at runtime today.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "worker-client",
    {
      description:
        "Advisory — signals the plugin wraps an external process (e.g. Python uv runtime). Not gated at runtime today.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "document-indexer",
    {
      description:
        "Advisory — signals the plugin can accept on-demand file paths for indexing via a supported scan tool. Used by host capability resolver for drag & drop IPC routing.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "conversation-trigger",
    {
      description:
        "Advisory self-identification capability token. It does not grant hostApi.triggerConversation(); runtime gating uses host:overlay only.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "lifecycle-observer",
    {
      description:
        "Advisory (v3.x) — signals the plugin uses getInstalledPluginIds() or onPluginsChanged() to observe peer-plugin lifecycle. Not enforced at runtime yet; declare it now for forward-compatibility when enforcement is added.",
      enforcement: "advisory",
      gates: [],
    },
  ],
  [
    "host:overlay",
    {
      description:
        "Plugin may call hostApi.triggerConversation() as an Overlay Runner. The host holds the spec in OverlayContext staging (fresh ConversationLoop is NOT started). User confirm inserts the prompt as a user message into main chat via the imported_trigger mechanism. Required because the overlay surface lets plugins inject text the user sees before any LLM turn — must be curated.",
      enforcement: "enforced",
      gates: ["triggerConversation"],
    },
  ],
]);

/**
 * Map of event namespace prefix → capability required to EMIT events in that
 * namespace. Plugins without the capability have their emissions dropped
 * (log.warn + no fan-out).
 *
 * `task` namespace is absent — host-side TaskDeadlinePoller and TaskService
 * were removed in 2026-05. Task ownership now lives in plugins.
 * If a plugin ever emits `task.*`, add a `tasks-source` capability here.
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
 */
export const PUBLIC_EVENT_NAMESPACES: ReadonlySet<string> = new Set([
  "meeting",
  "calendar",
  "email",
  "index",
  "task",
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
  const prefix = eventType.split(".")[0] ?? "";
  if (PUBLIC_EVENT_NAMESPACES.has(prefix)) return "public";
  return "neutral";
}
