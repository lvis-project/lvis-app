/**
 * Boot module — shared types + event bus
 *
 * Event handlers live here so every boot/* module publishes/subscribes
 * on the same map. Keeps boot.ts and boot/plugins.ts in sync without a
 * circular dependency.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { PluginMarketplaceService } from "../plugins/marketplace.js";
import type { TaskService } from "../taskService.js";
import type { SettingsService } from "../data/settings-store.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { ConversationLoop } from "../engine/conversation-loop.js";
import type { ProactiveEngine } from "../core/proactive-engine.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { AuditService } from "../main/audit-service.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { StarredStore } from "../data/starred-store.js";
import type { FeedbackStore } from "../data/feedback-store.js";
import type { TelemetryService } from "../main/telemetry.js";
import type { PluginTelemetryClient } from "../telemetry/client.js";
import type { TaskSourceRegistry } from "../plugins/task-source-registry.js";

export type EventHandler = (data: unknown) => void;

const eventHandlers = new Map<string, Set<EventHandler>>();

export function emitEvent(type: string, data?: unknown): void {
  const handlers = eventHandlers.get(type);
  if (handlers) {
    for (const handler of handlers) {
      try { handler(data); } catch (err) { console.error(`[lvis] event handler error (${type}):`, err); }
    }
  }
}

/**
 * Subscribe to a host event. Returns an unsubscribe disposer so callers
 * (PluginRuntime.onDisable, test cleanup) can remove handlers
 * deterministically without having to hold onto the original reference.
 */
export function onEvent(type: string, handler: EventHandler): () => void {
  if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
  eventHandlers.get(type)!.add(handler);
  return () => {
    eventHandlers.get(type)?.delete(handler);
  };
}

export function offEvent(type: string, handler: EventHandler): void {
  eventHandlers.get(type)?.delete(handler);
}

export interface AppServices {
  pluginRuntime: PluginRuntime;
  pluginMarketplace: PluginMarketplaceService;
  taskService: TaskService;
  taskSourceRegistry: TaskSourceRegistry;
  settingsService: SettingsService;
  memoryManager: MemoryManager;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  systemPromptBuilder: SystemPromptBuilder;
  conversationLoop: ConversationLoop;
  proactiveEngine: ProactiveEngine;
  mcpManager: McpManager;
  idleScheduler?: IdleSchedulerService;
  bashAstValidator: BashAstValidator;
  auditService: AuditService;
  /** A3 — structured audit logger (JSONL, ~/.lvis/audit/) */
  auditLogger: AuditLogger;
  postTurnHookChain: PostTurnHookChain;
  /** B1: 승인 게이트 — mainWindow 준비 후 생성 */
  approvalGate?: ApprovalGate;
  /** Whether knowledge search tools were successfully registered. */
  knowledgeAvailable: boolean;
  /** Sprint 4.C — starred messages persistence (~/.lvis/starred.json) */
  starredStore?: StarredStore;
  /** D6 privacy hardening — feedback persistence separate from audit log (~/.lvis/feedback.jsonl) */
  feedbackStore?: FeedbackStore;
  /** 플러그인 설치/제거 후 OS 알림 핸들러를 재구성한다. */
  refreshPluginNotifications?: () => void;
  /**
   * Issue 5: Re-register the generic plugin event bridge for a new window.
   * Call on macOS `activate` when a new BrowserWindow is created.
   */
  registerPluginEventBridge?: (win: import("electron").BrowserWindow) => void;
  /**
   * Release-prep — anonymous telemetry service. Retained here so
   * `before-quit` can run a final flush + stop() before the process exits
   * (otherwise queued events are lost on shutdown).
   */
  telemetry?: TelemetryService;
  /**
   * S12 — plugin lifecycle telemetry client (opt-in). Tracks
   * plugin_install / plugin_uninstall / plugin_update / plugin_error events
   * to POST /telemetry/events on the marketplace backend.
   * Never active until the user answers the first-boot consent prompt.
   */
  pluginTelemetry?: PluginTelemetryClient;
  /**
   * Release-prep — auto-updater stop handle. Retained so shutdown can
   * clear the 4h interval deterministically instead of relying on unref().
   */
  autoUpdaterStop?: () => void;
}
