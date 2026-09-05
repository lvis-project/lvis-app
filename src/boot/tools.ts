



import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import { type Tool } from "../tools/base.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createRequestPluginTool } from "../tools/request-plugin.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createRoutineScheduleTool } from "../tools/routine-schedule.js";
import { createSessionTasksTool } from "../tools/session-tasks.js";
import { createSessionGoalTool } from "../tools/session-goal.js";
import {
  createAgentInterruptTool,
  createAgentSpawnTool,
  createAgentStatusTool,
} from "../tools/agent-spawn.js";
import type { AgentSpawnEvent } from "../shared/subagent-events.js";
import { createSkillLoadTool, type SkillLoadEvent, type SkillLoadToolDeps } from "../tools/skill-load.js";
import { createSkillListTool } from "../tools/skill-list.js";
import { createSkillReadTool } from "../tools/skill-read.js";
import {
  createMcpResourceListTool,
  createMcpResourceReadTool,
  type McpResourceAccessResolver,
} from "../tools/mcp-resource-tools.js";
import { createAgentListTool } from "../tools/agent-list.js";
import { createAgentGuideTool } from "../tools/agent-guide.js";
import { createAgentSendTool, type AgentSendRuntime } from "../tools/agent-send.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { SessionTasksStore } from "../main/session-tasks-store.js";
import type { SessionGoalStore } from "../main/session-goal-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { SkillStore } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { IdleSchedulerService, adaptPowerMonitor } from "../main/idle-scheduler.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export function registerRequestPluginMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createRequestPluginTool());
}

export function registerToolSearchMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createToolSearchTool());
}

/**
 * §6.1 idle scheduler — the idle/throttle state machine the shared idle
 * consumers subscribe to (preference refresh, memory consolidation, post-turn
 * signalling, conversation loop). It takes only `powerMonitor`: indexing does
 * not defer through it, because the local-indexer plugin's FolderAutoIndexer
 * indexes eagerly in its own background worker process.
 *
 * Constructed unconditionally. Every consumer guards on the scheduler being
 * present and does nothing at all without it, so anything that can leave it
 * unbuilt disables idle work outright rather than degrading it.
 */
export async function wireIdleScheduler(): Promise<IdleSchedulerService | undefined> {
  try {
    const { powerMonitor } = await import("electron");
    const idleScheduler = new IdleSchedulerService({
      powerMonitor: adaptPowerMonitor(powerMonitor),
    });
    idleScheduler.start();
    return idleScheduler;
  } catch (err) {
    log.warn(
      "boot: idle-scheduler setup failed (non-fatal): %s",
      (err as Error).message,
    );
    return undefined;
  }
}

export interface WorkflowToolDeps {
  /** Lazy-resolved gate — populated after BrowserWindow is ready. */
  getAskUserQuestionGate?: () => AskUserQuestionGate | undefined;
  routinesStore?: RoutinesStore;
  sessionTasksStore?: SessionTasksStore;
  sessionGoalStore?: SessionGoalStore;
  /** Lazy-resolved sub-agent runner — populated after ConversationLoop wiring. */
  getSubAgentRunner?: () => SubAgentRunner | undefined;
  /** Host-only A2A runtime; agent_send still rejects every non-child context. */
  getAgentSendRuntime?: () => AgentSendRuntime | undefined;
  skillStore?: SkillStore;
  agentProfileStore?: AgentProfileStore;
  /** C2(c): per-session skill overlay registry. */
  skillOverlay?: SkillOverlay;
  /** C2(d): persistent skill-approval allowlist. */
  skillApprovalsStore?: SkillApprovalsStore;
  /** C2(d): ApprovalGate for the first-use skill approval dock. */
  approvalGate?: ApprovalGate;
  /**
   * Electron network-stack fetch (`net.fetch`) — routes builtin tool traffic
   * through Chromium's network stack (system proxy/PAC, OS certificate store)
   * rather than Node's global `fetch`.
   */
  networkFetch: typeof fetch;
  emitAgentSpawn?: (event: AgentSpawnEvent) => void;
  emitSkillLoad?: (event: SkillLoadEvent) => void;
  acquirePluginSkillGeneration?: NonNullable<SkillLoadToolDeps["acquirePluginGeneration"]>;
  /**
   * Lazy-resolved MCP resource access. Lazy because the MCP manager is built in a
   * LATER boot step than the builtin tools, and narrow (list + read only) so this
   * surface cannot reach `callTool`.
   */
  getMcpResourceAccess?: McpResourceAccessResolver;
}

export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
  workflowDeps: WorkflowToolDeps,
): void {
  const { networkFetch } = workflowDeps;
  const builtins: Tool[] = [
    createWebSearchTool(settingsService, networkFetch),
    createWebFetchTool(networkFetch),
    createRenderHtmlTool(),
  ];

  // Workflow system tools. Each is gated on its dependency being
  // wired so unit tests that boot a minimal registry stay green.
  if (workflowDeps?.getAskUserQuestionGate) {
    builtins.push(
      createAskUserQuestionTool({
        getGate: workflowDeps.getAskUserQuestionGate,
      }),
    );
  }
  if (workflowDeps?.routinesStore) {
    builtins.push(createRoutineScheduleTool(workflowDeps.routinesStore));
  }
  if (workflowDeps?.sessionTasksStore) {
    builtins.push(createSessionTasksTool(workflowDeps.sessionTasksStore));
  }
  if (workflowDeps?.sessionGoalStore) {
    builtins.push(createSessionGoalTool(workflowDeps.sessionGoalStore));
  }
  if (workflowDeps?.getSubAgentRunner && workflowDeps.emitAgentSpawn) {
    const agentProfileStore = workflowDeps.agentProfileStore;
    builtins.push(
      createAgentSpawnTool({
        getRunner: workflowDeps.getSubAgentRunner,
        getAgentProfile: agentProfileStore
          ? async (name) => await agentProfileStore.load(name)
          : undefined,
        emit: workflowDeps.emitAgentSpawn,
      }),
      createAgentStatusTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
      createAgentInterruptTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
      // The other half of the same relationship: `agent_interrupt` ends a run,
      // `agent_guide` redirects one that should keep going.
      createAgentGuideTool({
        getRunner: workflowDeps.getSubAgentRunner,
      }),
    );
  }
  if (workflowDeps?.agentProfileStore) {
    builtins.push(createAgentListTool({
      store: workflowDeps.agentProfileStore,
      // Same runner accessor agent_spawn uses, so the list can name THIS
      // conversation's resumable sub-agents next to the profile definitions.
      getRunner: workflowDeps.getSubAgentRunner,
    }));
  }
  if (workflowDeps?.getAgentSendRuntime) {
    builtins.push(createAgentSendTool({
      getRuntime: workflowDeps.getAgentSendRuntime,
    }));
  }
  if (
    workflowDeps?.skillStore &&
    workflowDeps.emitSkillLoad &&
    workflowDeps.skillOverlay &&
    workflowDeps.skillApprovalsStore &&
    workflowDeps.approvalGate
  ) {
    builtins.push(
      createSkillLoadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        approvals: workflowDeps.skillApprovalsStore,
        approvalGate: workflowDeps.approvalGate,
        emit: workflowDeps.emitSkillLoad,
        acquirePluginGeneration: workflowDeps.acquirePluginSkillGeneration,
      }),
    );
    builtins.push(createSkillListTool(workflowDeps.skillStore));
    // Stage-3 companion: reads one bundled resource of an ALREADY-LOADED skill.
    // Registered beside skill_load because it reuses the same overlay as its
    // access-control surface (loaded ⇒ approved) and the same generation lease.
    builtins.push(
      createSkillReadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        acquirePluginGeneration: workflowDeps.acquirePluginSkillGeneration,
      }),
    );
  }

  // MCP resources — the MODEL's path to server-declared documents/schemas. The
  // user's path (a composer mention) is a separate surface; reference hosts expose
  // both.
  //
  // The resolver is passed through, not called: `ctx.mcpManager` is assigned by a
  // LATER boot step, so anything captured here would be the registration-time
  // `undefined` forever. Callers that supply no resolver at all (the minimal test
  // registry) get no tools; production always supplies one, and the tools report
  // "not ready" themselves during the window before MCP setup runs.
  const mcpResourceAccess = workflowDeps?.getMcpResourceAccess;
  if (mcpResourceAccess) {
    builtins.push(createMcpResourceListTool(mcpResourceAccess));
    builtins.push(createMcpResourceReadTool(mcpResourceAccess));
  }

  toolRegistry.registerBatch(builtins);
}
