/**
 * Cross-plugin access-control policy.
 *
 * Consolidates the deny/allow gate + audit + error-message construction for
 * the three plugin trust boundaries the runtime enforces:
 *   - event subscription across plugins (`assertEventSubscribeAccess`)
 *   - event emission of another plugin's event (`assertEventEmitAccess`)
 *   - renderer→plugin invocation allowlist (`assertUiActionInvokable`)
 *
 * Each function is pure given its resolved inputs; the runtime resolves the
 * owner/grant/state and delegates the policy decision here so the rules and
 * their audit trail live in one place.
 */
import type { PluginAccessSpec } from "../types.js";

type AuditLog = (
  level: "info" | "warn" | "error",
  message: string,
  data?: unknown,
) => void;

/**
 * Enforce that `callerPluginId` may subscribe to `eventType` from its owning
 * plugin. Self-owned or unowned events are always allowed; otherwise the
 * caller must hold an explicit event grant.
 */
export function assertEventSubscribeAccess(opts: {
  callerPluginId: string;
  eventType: string;
  targetPluginId: string | undefined;
  getAccessGrant: () => PluginAccessSpec | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, targetPluginId } = opts;
  if (!targetPluginId || targetPluginId === callerPluginId) return;
  const rule = opts
    .getAccessGrant()
    ?.plugins.find((entry) => entry.pluginId === targetPluginId);
  if (rule?.events?.includes(eventType)) return;
  opts.auditLog?.("error", "plugin_event_access_denied", {
    callerPluginId,
    targetPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to subscribe to event '${eventType}' from plugin '${targetPluginId}'`,
  );
}

/**
 * Enforce that `callerPluginId` may emit `eventType`. A plugin may only emit
 * events it owns (or events with no resolvable owner).
 */
export function assertEventEmitAccess(opts: {
  callerPluginId: string;
  eventType: string;
  ownerPluginId: string | undefined;
  auditLog?: AuditLog;
}): void {
  const { callerPluginId, eventType, ownerPluginId } = opts;
  if (!ownerPluginId || ownerPluginId === callerPluginId) return;
  opts.auditLog?.("error", "plugin_event_emit_denied", {
    callerPluginId,
    ownerPluginId,
    eventType,
  });
  throw new Error(
    `Plugin '${callerPluginId}' is not allowed to emit event '${eventType}' owned by plugin '${ownerPluginId}'`,
  );
}

/**
 * Enforce the renderer→plugin allowlist: only tools whose `_meta.ui.visibility`
 * includes `"app"` (#885 v6 — app-visible / dual) may be invoked from the UI IPC
 * bridge. `uiInvokable` is derived by `declaredUiInvokableMethods`.
 */
export function assertUiActionInvokable(opts: {
  method: string;
  pluginId: string;
  uiInvokable: string[];
}): void {
  if (!opts.uiInvokable.includes(opts.method)) {
    throw new Error(
      `Method '${opts.method}' is not declared as a UI action for plugin '${opts.pluginId}'. ` +
        `Give its tools[] entry "_meta":{"ui":{"visibility":["app"]}} (or ["model","app"]) to allow renderer invocation.`,
    );
  }
}
