/**
 * Boot §4.2 Step 3–5 — Plugin orchestration helpers.
 *
 * - buildPluginConfigOverrides: 범용 API key 주입
 * - registerPluginTools / runManifestStartupTools: manifest-driven wiring
 * - registerManifestEventSubscriptions / buildManifestEventHints: event hint helpers
 * - registerPluginNotifications: OS 알림 (manifest.notificationEvents)
 * - findMethodByCapability: capability → tool 이름 resolver
 */
import { Notification } from "electron";
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import { classifySubscription } from "../plugins/capabilities.js";
import { pluginToolsForRegistration } from "../plugins/plugin-tool-adapter.js";
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

/** 현재 LLM 벤더의 API 키를 모든 플러그인에 범용으로 전달 */
export function buildPluginConfigOverrides(settings: SettingsService): Record<string, Record<string, unknown>> {
  const overrides: Record<string, Record<string, unknown>> = {};
  const llm = settings.get("llm");

  // OpenAI 키는 STT/Summary 플러그인이 공통으로 사용.
  // 글로벌 process.env 오염 금지 — configOverrides를 통한 명시적 주입만 허용.
  // (cycle 1 LOW: process.env.OPENAI_API_KEY 글로벌 set 제거)
  const openaiKey = settings.getSecret("llm.apiKey.openai");
  const currentKey = settings.getSecret(`llm.apiKey.${llm.provider}`);

  // 모든 플러그인에 범용적으로 전달 — 각 플러그인이 필요한 키를 선택
  const resolvedApiKey = openaiKey ?? currentKey;
  if (resolvedApiKey) {
    overrides["*"] = {
      llmApiKey: resolvedApiKey,
      llmProvider: llm.provider,
      apiKey: resolvedApiKey,         // Local Indexer 등 플러그인이 사용하는 키 이름
      openaiApiKey: resolvedApiKey,   // meeting이 사용하는 키 이름
    };
  }

  // Merge per-plugin configs from settings
  const pluginConfigs = settings.get("pluginConfigs");
  for (const [pluginId, config] of Object.entries(pluginConfigs)) {
    overrides[pluginId] = { ...(overrides[pluginId] ?? {}), ...config };
  }

  return overrides;
}

export function registerPluginTools(pluginRuntime: PluginRuntime, toolRegistry: ToolRegistry): void {
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const tool of pluginToolsForRegistration(pluginRuntime, pluginId, manifest)) {
      toolRegistry.register(tool);
    }
  }
}

/**
 * Phase 5 §5 — fail-soft startupTools.
 * One throwing startupTool does NOT unload the plugin and does NOT abort the
 * remaining startupTools. Each failure is logged as a warning so operators
 * can diagnose, while the plugin keeps serving the rest of its handlers.
 */
export function runManifestStartupTools(pluginRuntime: PluginRuntime): void {
  const loadedTools = new Set(pluginRuntime.listToolNames());
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const tool of manifest.startupTools ?? []) {
      if (!loadedTools.has(tool)) {
        log.warn(
          `boot: startup tool not loaded (plugin=${pluginId}, tool=${tool})`,
        );
        continue;
      }
      // fail-soft: catch + warn, never unload the plugin, never abort sibling
      // startupTools. The loaded plugin list is unaffected.
      pluginRuntime.call(tool, {}).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(
          `boot: startup-tool-failed (non-fatal, plugin=${pluginId}, tool=${tool}): %s`,
          msg,
        );
      });
    }
  }
}

export function registerManifestEventSubscriptions(
  pluginRuntime: PluginRuntime,
  eventCollector: EventCollector,
  auditLogger?: Pick<AuditLogger, "log">,
): void {
  const eventTypes = new Set<string>();
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const entry of manifest.eventSubscriptions ?? []) {
      const eventType = typeof entry === "string" ? entry : entry.type;
      // Phase 5 — namespace allowlist. Private namespaces (memory.private.*,
      // settings.apiKey.*, audit.*, dlp.*) are never exposed to plugins;
      // neutral namespaces pass with a warn so ops can track drift.
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
        // M4: audit-log unauthorized private namespace subscription attempts.
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
        // Backward-compatible string form: neutral fallback hint
        hints[entry] = { category: "system", priority: "low", title: entry };
      } else {
        // Object form: use plugin-declared hint if present, else fallback
        hints[entry.type] = entry.hint
          ? { category: entry.hint.category, priority: entry.hint.priority, title: entry.hint.title }
          : { category: "system", priority: "low", title: entry.type };
      }
    }
  }
  return hints;
}

/**
 * manifest.emittedEvents 선언 기반으로 renderer 이벤트 브릿지를 등록한다.
 * classifySubscription("public") 판정을 통과한 이벤트만 webContents.send 로 전달.
 * 플러그인 특정 리터럴 없음 — boot.ts에 plugin ID/event 하드코딩 금지.
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

/** manifest.notificationEvents 선언 기반으로 OS 알림을 등록한다. 플러그인 특정 코드 없음. */
export function registerPluginNotifications(
  pluginRuntime: PluginRuntime,
  mainWindow: BrowserWindow,
): () => void {
  if (!Notification.isSupported()) return () => {};

  const registered: Array<{ type: string; handler: EventHandler }> = [];
  // manifest는 JSON에서 읽으므로 런타임 검증 필요. 또한 여러 플러그인이 같은 이벤트를
  // 알림으로 선언하면 한 번의 emit에 알림이 중복으로 뜨므로 event별로 1개만 등록.
  const registeredEvents = new Set<string>();

  for (const { manifest } of pluginRuntime.listPluginManifests()) {
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
      if (registeredEvents.has(event)) {
        log.warn(`boot: duplicate notificationEvents entry for "${event}" — keeping first, skipping rest`);
        continue;
      }
      registeredEvents.add(event);
      const { titleField, bodyField } = spec;
      const handler: EventHandler = (data) => {
        const resolvedTitle = titleField ? getFieldByPath(data, titleField) : "";
        const title = resolvedTitle || event;
        const body = bodyField ? getFieldByPath(data, bodyField) : "";
        const notif = new Notification({ title, body, silent: false });
        notif.on("click", () => {
          // macOS에서 창 닫힌 뒤에도 알림이 살아 있을 수 있음 — destroyed 창 접근 시 throw 방지
          if (mainWindow.isDestroyed()) return;
          mainWindow.show();
          mainWindow.focus();
        });
        notif.show();
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

export function findMethodByCapability(
  pluginRuntime: PluginRuntime,
  capability: string,
  matcher: (tool: string) => boolean,
): string | undefined {
  const pluginId = pluginRuntime.findPluginIdByCapability(capability);
  if (!pluginId) return undefined;
  const manifest = pluginRuntime.getPluginManifest(pluginId);
  if (!manifest) return undefined;
  return manifest.tools.find(matcher);
}

export function findPreferredMethodByCapability(
  pluginRuntime: PluginRuntime,
  capability: string,
  preferredTools: readonly string[],
): string | undefined {
  const pluginId = pluginRuntime.findPluginIdByCapability(capability);
  if (!pluginId) return undefined;
  const manifest = pluginRuntime.getPluginManifest(pluginId);
  if (!manifest) return undefined;
  // Capability-driven callers that know a protocol payload should choose from
  // an explicit allow-list instead of accepting every *_scan alias exposed by a
  // provider. This keeps host routing stable across plugin/product renames.
  return preferredTools.find((tool) => manifest.tools.includes(tool));
}
