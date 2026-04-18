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
import type { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";

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

export function onEvent(type: string, handler: EventHandler): void {
  if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
  eventHandlers.get(type)!.add(handler);
}

export function offEvent(type: string, handler: EventHandler): void {
  eventHandlers.get(type)?.delete(handler);
}

export interface AppServices {
  pluginRuntime: PluginRuntime;
  pluginMarketplace: PluginMarketplaceService;
  taskService: TaskService;
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
  postTurnHookChain: PostTurnHookChain;
  /** B1: 승인 게이트 — mainWindow 준비 후 생성 */
  approvalGate?: ApprovalGate;
  /** Whether knowledge search tools were successfully registered. */
  knowledgeAvailable: boolean;
  /** 플러그인 설치/제거 후 OS 알림 핸들러를 재구성한다. */
  refreshPluginNotifications?: () => void;
}
