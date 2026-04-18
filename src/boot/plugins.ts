/**
 * Boot §4.2 Step 3–5 — Plugin orchestration helpers.
 *
 * - buildPluginConfigOverrides: 범용 API key 주입
 * - registerPluginTools / runManifestStartupTools: manifest-driven wiring
 * - registerManifestEventSubscriptions / buildManifestEventHints: proactive hints
 * - registerPluginNotifications: OS 알림 (manifest.notificationEvents)
 * - findMethodByCapability: capability → tool 이름 resolver
 */
import { Notification } from "electron";
import type { BrowserWindow } from "electron";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import type { ProactiveEngine } from "../core/proactive-engine.js";
import { pluginToolsForRegistration } from "../plugins/plugin-tool-adapter.js";
import { classifySubscription } from "../plugins/capabilities.js";
import { type EventHandler, onEvent, offEvent } from "./types.js";

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
      apiKey: resolvedApiKey,         // pageindex가 사용하는 키 이름
      openaiApiKey: resolvedApiKey,   // meeting이 사용하는 키 이름
    };
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

export function runManifestStartupTools(pluginRuntime: PluginRuntime): void {
  const loadedTools = new Set(pluginRuntime.listToolNames());
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const tool of manifest.startupTools ?? []) {
      if (!loadedTools.has(tool)) {
        console.warn(
          `[lvis] boot: startup tool not loaded (plugin=${pluginId}, tool=${tool})`,
        );
        continue;
      }
      pluginRuntime.call(tool, {}).catch((e: Error) =>
        console.log(
          `[lvis] boot: startup tool failed (non-fatal, plugin=${pluginId}, tool=${tool}):`,
          e.message,
        ),
      );
    }
  }
}

export function registerManifestEventSubscriptions(
  pluginRuntime: PluginRuntime,
  proactiveEngine: ProactiveEngine,
): void {
  const eventTypes = new Set<string>();
  for (const { pluginId, manifest } of pluginRuntime.listPluginManifests()) {
    for (const eventType of manifest.eventSubscriptions ?? []) {
      // Phase 5 — namespace allowlist. Private namespaces (memory.private.*,
      // settings.apiKey.*, audit.*, dlp.*) are never exposed to plugins;
      // neutral namespaces pass with a warn so ops can track drift.
      const verdict = classifySubscription(eventType);
      if (verdict === "private") {
        console.warn(
          `[lvis] plugin:${pluginId} eventSubscriptions['${eventType}'] dropped — private namespace`,
        );
        continue;
      }
      if (verdict === "neutral") {
        console.warn(
          `[lvis] plugin:${pluginId} eventSubscriptions['${eventType}'] — outside public allowlist (allowed with warn)`,
        );
      }
      eventTypes.add(eventType);
    }
  }
  for (const eventType of eventTypes) {
    onEvent(eventType, (data) => proactiveEngine.collectEvent(eventType, data));
  }
}

export function buildManifestEventHints(
  pluginRuntime: PluginRuntime,
): Record<string, import("../core/proactive-engine.js").ProactiveEventHint> {
  const hints: Record<string, import("../core/proactive-engine.js").ProactiveEventHint> = {};
  for (const { manifest } of pluginRuntime.listPluginManifests()) {
    for (const eventType of manifest.eventSubscriptions ?? []) {
      const [prefix] = eventType.split(".");
      if (prefix === "meeting") {
        hints[eventType] = {
          category: "meeting",
          priority: "medium",
          title: "회의 이벤트",
        };
        continue;
      }
      if (prefix === "email") {
        hints[eventType] = {
          category: "email",
          priority: "medium",
          title: eventType === "email.action.needed" ? "액션 필요 이메일" : "이메일 이벤트",
        };
        continue;
      }
      if (prefix === "calendar") {
        hints[eventType] = {
          category: "calendar",
          priority: "low",
          title: "일정 이벤트",
        };
        continue;
      }
      hints[eventType] = {
        category: "system",
        priority: "low",
        title: eventType,
      };
    }
  }
  return hints;
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
        console.warn("[lvis] boot: invalid notificationEvents spec (expected object), skipped:", spec);
        continue;
      }
      const event = typeof spec.event === "string" ? spec.event.trim() : "";
      if (!event) {
        console.warn("[lvis] boot: notificationEvents spec with missing/empty 'event' skipped:", spec);
        continue;
      }
      if (spec.titleField !== undefined && typeof spec.titleField !== "string") {
        console.warn(`[lvis] boot: notificationEvents[${event}].titleField must be string, skipped`);
        continue;
      }
      if (spec.bodyField !== undefined && typeof spec.bodyField !== "string") {
        console.warn(`[lvis] boot: notificationEvents[${event}].bodyField must be string, skipped`);
        continue;
      }
      if (registeredEvents.has(event)) {
        console.warn(`[lvis] boot: duplicate notificationEvents entry for "${event}" — keeping first, skipping rest`);
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
