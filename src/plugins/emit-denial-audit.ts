/**
 * Single authority for the plugin emit-denial audit trail.
 *
 * Two production lanes deny plugin event emission on the SAME predicate
 * (`canEmitEvent`, src/plugins/capabilities.ts):
 *   - "plugin"     — SDK lane: `hostApi.emitEvent` in
 *                    boot/steps/plugin-runtime/host-api-factory.ts
 *   - "ipc-bridge" — webview lane: the `lvis:plugin:emit-event` handler in
 *                    ipc/domains/plugins.ts, reached from plugin-preload.ts
 *
 * Before this module the SDK lane wrote an audit row plus a CAPABILITY_DENY
 * lifecycle line and the webview lane wrote nothing, so a denied emit was
 * forensically invisible exactly when it came from the LESS trusted caller
 * (sandboxed webview JS). The row shape and the lifecycle line live here so
 * there is one definition of "a plugin emit was denied", not one per lane.
 */
import type { AuditEntry } from "../audit/audit-logger.js";
import { requiredCapabilityForEmit } from "./capabilities.js";
import { logPluginLifecycle, PluginPhase } from "./lifecycle-log.js";

/**
 * Which production emit lane denied. Recorded as the audit row's `sessionId`,
 * matching the sessionId convention each lane already uses for its other rows,
 * so an auditor can tell a sandboxed-webview denial from an SDK-side one.
 */
export type PluginEmitLane = "plugin" | "ipc-bridge";

/**
 * Record a denied plugin emit on both observability channels.
 *
 * Returns the internal effect label for the denied namespace
 * ({@link requiredCapabilityForEmit}) — `undefined` for host-reserved and
 * plugin-private namespaces, which are denied without a capability label. The
 * webview lane renders it into its `missing-capability:` wire error, so callers
 * need not recompute it.
 */
export function auditPluginEmitDenial(params: {
  auditLogger: { log: (entry: AuditEntry) => void };
  lane: PluginEmitLane;
  pluginId: string;
  eventType: string;
  declaredEmittedEvents: readonly string[];
}): string | undefined {
  const { auditLogger, lane, pluginId, eventType, declaredEmittedEvents } = params;
  const requiredCapability = requiredCapabilityForEmit(eventType);
  try {
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: lane,
      type: "error",
      input: `[plugin:${pluginId}] plugin_emit_capability_denied eventType=${eventType} required=${requiredCapability} declaredEmittedEvents=${declaredEmittedEvents.join("|")}`,
    });
  } catch { /* audit must not break host */ }
  logPluginLifecycle(
    "warn",
    {
      pluginId,
      phase: PluginPhase.CAPABILITY_DENY,
      capability: requiredCapability ?? eventType,
      eventType,
      reason: "missing_capability",
    },
    "capability denied",
  );
  return requiredCapability;
}
