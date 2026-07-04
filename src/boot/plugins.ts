



import { Notification } from "electron";
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { SettingsService } from "../data/settings-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { NotificationService } from "../main/notification-service.js";
import { classifySubscription } from "../plugins/capabilities.js";
import { type EventHandler, onEvent, offEvent } from "./types.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export interface EventCollector {
  collectEvent(type: string, data?: unknown): void;
}

export interface EventHint {
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
}

/**
 * Build the plugin configOverrides map: non-secret metadata only.
 *
 * PR #894 Cycle 3 CRIT-1 — the wildcard slot must never carry `llmApiKey`.
 * Plugins receive the actual key via `hostApi.getSecret("llm.apiKey.<vendor>")`,
 * which routes through the three-tier `hostSecrets.read[]` allowlist gate.
 * Injecting the key here would bypass the gate and leak the secret to every
 * loaded plugin regardless of its manifest. The single non-secret signal
 * the host shares is `hostApiVendor`, which mirrors the contract that
 * `refreshActiveLlmWildcard` in `boot.ts` re-applies on every vendor change.
 *
 * Per-plugin entries in `pluginConfigs` are merged unchanged.
 */
export function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // Wildcard slot carries only non-secret metadata. The host secret stays
  // gated behind getSecret(); the previous `llmApiKey` injection (Cycle 2)
  // bypassed `hostSecrets.read[]` and is removed in Cycle 3 (CRIT-1).
  overrides["*"] = { hostApiVendor: llm.provider };

  // Merge per-plugin configs from settings
  const pluginConfigs = settings.get("pluginConfigs");
  for (const [pluginId, config] of Object.entries(pluginConfigs)) {
    overrides[pluginId] = { ...(overrides[pluginId] ?? {}), ...config };
  }

  return overrides;
}

// legacy-removal flag-day (mcp-alignment-design.md §5): the manifest-driven
// `pluginToolsForRegistration` registration path + its `registerPluginTools` /
// `syncPluginToolRegistry` / `syncPluginToolRegistryForPlugin` orchestration are
// REMOVED. Every plugin now registers through `PluginLoopbackManager` (the host
// runs each plugin as an in-process MCP server: server/discover → tools/list →
// reverse projection from `_meta`), wired in `boot/steps/plugin-runtime.ts`.

export function registerManifestEventSubscriptions(
  pluginRuntime: PluginRuntime,
  eventCollector: EventCollector,
  auditLogger?: Pick<AuditLogger, "log">,
): void {
  const eventTypes = new Set<string>();
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      const eventType = typeof entry === "string" ? entry : entry.type;
      // Namespace allowlist. Private namespaces (memory.private.*,
      // settings.apiKey.*, audit.*, dlp.*) are never exposed to plugins;
      // neutral namespaces pass with a warn so ops can track drift.
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
        // Audit unauthorized private namespace subscription attempts.
        try {
          auditLogger?.log({
            timestamp: new Date().toISOString(),
            sessionId: "plugin",
            type: "error",
            input: `[plugin:${pluginId}] plugin_subscription_private_denied eventType=${eventType}`,
          });
        } catch { /* audit must not break host */ }
        log.warn(
          `plugin:${pluginId} eventSubscriptions['${eventType}'] dropped — private namespace`,
        );
        continue;
      }
      if (verdict === "neutral") {
        log.warn(
          `plugin:${pluginId} eventSubscriptions['${eventType}'] — outside public allowlist (allowed with warn)`,
        );
      }
      eventTypes.add(eventType);
    }
  }
  for (const eventType of eventTypes) {
    onEvent(eventType, (data) => eventCollector.collectEvent(eventType, data));
  }
}

export function buildManifestEventHints(
  pluginRuntime: PluginRuntime,
): Record<string, EventHint> {
  const hints: Record<string, EventHint> = {};
  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      if (typeof entry === "string") {
        // String form: neutral default hint.
        hints[entry] = { category: "system", priority: "low", title: entry };
      } else {
        // Object form: use plugin-declared hint if present, else default hint.
        hints[entry.type] = entry.hint
          ? { category: entry.hint.category, priority: entry.hint.priority, title: entry.hint.title }
          : { category: "system", priority: "low", title: entry.type };
      }
    }
  }
  return hints;
}

/**
 * Register renderer event bridges from manifest.emittedEvents declarations.
 * Only events that pass classifySubscription("public") are forwarded with webContents.send.
 * Keep this plugin-agnostic: do not hardcode plugin IDs or event literals in boot.ts.
 */
export function registerPluginEventBridge(
  pluginRuntime: PluginRuntime,
  mainWindow: import("electron").BrowserWindow,
): () => void {
  const registered: Array<{ type: string; handler: EventHandler }> = [];
  const registeredEvents = new Set<string>();

  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    for (const eventType of manifest.emittedEvents ?? []) {
      if (registeredEvents.has(eventType)) continue;
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
        log.warn(
          `boot: emittedEvents["${eventType}"] is private-namespace — bridge skipped`,
        );
        continue;
      }
      registeredEvents.add(eventType);
      const handler: EventHandler = (data) => {
        if (mainWindow.isDestroyed()) return;
        try {
          mainWindow.webContents.send("lvis:plugin:event", eventType, data);
        } catch (e) {
          log.warn(
            `boot: plugin-event-bridge send failed (${eventType}): %s`,
            (e as Error).message,
          );
        }
      };
      onEvent(eventType, handler);
      registered.push({ type: eventType, handler });
    }
  }

  return () => {
    for (const { type, handler } of registered) offEvent(type, handler);
  };
}

/**
 * Register OS notifications from manifest.notificationEvents declarations.
 *
 * Routes every plugin emit through {@link NotificationService} (#841) so
 * plugin notifications inherit:
 *   - per-kind cooldown (5 s for `plugin`) — defangs a runaway plugin
 *     emitting 30 events/sec from blasting OS toasts
 *   - 80-char body cap + ANSI/markdown/control-char stripping
 *   - in-app toast vs OS routing decision (NotificationService.fire picks
 *     based on `isAnyWindowFocused()` — #842, multi-window safe)
 *   - click-to-restore-minimized
 *   - structured `notification.fired` / `notification.suppressed` audit rows
 *
 * Per-event `bypassFocusGate?: boolean` (#843) opts out of the focus
 * suppression for critical surfaces (`meeting.starting-soon`,
 * `approval.deadline-imminent`, etc.) — the OS notification fires
 * regardless of any focused LVIS window.
 *
 * The `mainWindow` parameter is retained for the early `isSupported()` /
 * destroyed-window guard; the actual fire pipeline goes through
 * `notificationService` (which has its own live `getMainWindow` getter for
 * the click-restore path).
 */
export function registerPluginNotifications(
  pluginRuntime: PluginRuntime,
  mainWindow: BrowserWindow,
  notificationService: NotificationService,
  auditLogger?: Pick<AuditLogger, "log">,
): () => void {
  if (!Notification.isSupported()) return () => {};

  const registered: Array<{ type: string; handler: EventHandler }> = [];
  // Manifests come from JSON, so runtime validation is required. Multiple plugins
  // can declare the same event as a notification, so register only once per event.
  const registeredEvents = new Set<string>();

  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    const pluginId = manifest.id;
    const notificationEvents = Array.isArray(manifest.notificationEvents)
      ? manifest.notificationEvents
      : [];
    for (const spec of notificationEvents) {
      if (!spec || typeof spec !== "object") {
        log.warn("boot: invalid notificationEvents spec (expected object), skipped: %s", spec);
        continue;
      }
      const event = typeof spec.event === "string" ? spec.event.trim() : "";
      if (!event) {
        log.warn("boot: notificationEvents spec with missing/empty 'event' skipped: %s", spec);
        continue;
      }
      if (spec.titleField !== undefined && typeof spec.titleField !== "string") {
        log.warn(`boot: notificationEvents[${event}].titleField must be string, skipped`);
        continue;
      }
      if (spec.bodyField !== undefined && typeof spec.bodyField !== "string") {
        log.warn(`boot: notificationEvents[${event}].bodyField must be string, skipped`);
        continue;
      }
      if (spec.bypassFocusGate !== undefined && typeof spec.bypassFocusGate !== "boolean") {
        log.warn(`boot: notificationEvents[${event}].bypassFocusGate must be boolean, skipped`);
        continue;
      }
      if (registeredEvents.has(event)) {
        log.warn(`boot: duplicate notificationEvents entry for "${event}" — keeping first, skipping rest`);
        continue;
      }
      registeredEvents.add(event);
      const { titleField, bodyField, bypassFocusGate } = spec;
      const handler: EventHandler = (data) => {
        // Defensive: if the main window is destroyed between plugin emit and
        // dispatch, the click-restore inside NotificationService no-ops, but
        // we still audit the attempt so field telemetry can attribute
        // emit-during-shutdown to the originating plugin.
        //
        // #843 — `bypassFocusGate` is a manifest signal that the event is a
        // critical alert. A torn-down main window must NOT swallow such an
        // alert (e.g. `incident.page` during shutdown). When bypass is set,
        // fall through to NotificationService.fire; the OS notification still
        // surfaces, and the internal `isDestroyed()` guards on click-restore
        // handle the no-op safely.
        if (mainWindow.isDestroyed() && bypassFocusGate !== true) {
          try {
            auditLogger?.log({
              timestamp: new Date().toISOString(),
              sessionId: "plugin-notification",
              type: "info",
              input: JSON.stringify({
                event: "notification.suppressed",
                kind: "plugin",
                reason: "window-destroyed",
                pluginId,
                pluginEvent: event,
              }),
            });
          } catch {
            // audit failure must never block notification suppression
          }
          return;
        }
        const resolvedTitle = titleField ? getFieldByPath(data, titleField) : "";
        const title = resolvedTitle || event;
        const body = bodyField ? getFieldByPath(data, bodyField) : "";
        // Route through NotificationService — inherits focus gate (#842
        // multi-window-aware), cooldown, truncation, sanitization, click
        // restore, and audit. `bypassFocusGate` (#843) passes through to
        // FireOptions so meeting.starting-soon etc. fire regardless of focus.
        notificationService.fire({
          kind: "plugin",
          title,
          body,
          bypassFocusGate: bypassFocusGate === true,
        });
      };
      onEvent(event, handler);
      registered.push({ type: event, handler });
    }
  }

  return () => {
    for (const { type, handler } of registered) offEvent(type, handler);
  };
}

function getFieldByPath(data: unknown, path: string): string {
  const parts = path.split(".");
  let val: unknown = data;
  for (const p of parts) val = (val as Record<string, unknown>)?.[p];
  return typeof val === "string" ? val : "";
}
