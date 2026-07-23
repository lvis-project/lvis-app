



import type { ToolRegistry } from "../tools/registry.js";
import type { SettingsService } from "../data/settings-store.js";
import type { PluginRuntime } from "../plugins/runtime.js";
import type { AuditService } from "../main/audit-service.js";
import { type Tool } from "../tools/base.js";
import { createKnowledgeSearchTools } from "../tools/knowledge-search.js";
import { createRenderHtmlTool } from "../tools/render-html.js";
import { createWebSearchTool } from "../tools/web-search.js";
import { createWebFetchTool } from "../tools/web-fetch.js";
import { createRequestPluginTool } from "../tools/request-plugin.js";
import { createToolSearchTool } from "../tools/tool-search.js";
import { createAskUserQuestionTool } from "../tools/ask-user-question.js";
import { createRoutineScheduleTool } from "../tools/routine-schedule.js";
import { createTodoSessionWriteTool } from "../tools/todo-session-write.js";
import {
  createAgentInterruptTool,
  createAgentSpawnTool,
  createAgentStatusTool,
} from "../tools/agent-spawn.js";
import type { AgentSpawnEvent } from "../shared/subagent-events.js";
import { createSkillLoadTool, type SkillLoadEvent, type SkillLoadToolDeps } from "../tools/skill-load.js";
import { createSkillListTool } from "../tools/skill-list.js";
import { createAgentListTool } from "../tools/agent-list.js";
import { createAgentSendTool, type AgentSendRuntime } from "../tools/agent-send.js";
import type { AskUserQuestionGate } from "../main/ask-user-question-gate.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { SessionTodoStore } from "../main/session-todo-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import type { SkillStore } from "../main/skill-store.js";
import type { SkillOverlay } from "../main/skill-overlay.js";
import type { SkillApprovalsStore } from "../main/skill-approvals-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import { HybridRetriever } from "../main/hybrid-retriever.js";
import type { WorkerSearchClient } from "../main/hybrid-retriever.js";
import type { KnowledgeWorkerClient } from "../tools/knowledge-search.js";
import { MockCloudIndexAdapter } from "../main/cloud-index-adapter.js";
import { IdleSchedulerService, adaptPowerMonitor } from "../main/idle-scheduler.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export function registerRequestPluginMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createRequestPluginTool());
}

export function registerToolSearchMetaTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register(createToolSearchTool());
}

export interface KnowledgeWiringResult {
  idleScheduler?: IdleSchedulerService;
  knowledgeAvailable: boolean;
}

type KnowledgePluginInstance = {
  getWorkerClient?: () => WorkerSearchClient & KnowledgeWorkerClient;
};

export async function wireKnowledgeAndIdleScheduler(opts: {
  pluginRuntime: PluginRuntime;
  toolRegistry: ToolRegistry;
  auditService: AuditService;
}): Promise<KnowledgeWiringResult> {
  const { pluginRuntime, toolRegistry, auditService } = opts;
  let idleScheduler: IdleSchedulerService | undefined;
  let knowledgeAvailable = false;
  try {
    const workerClientPluginId = pluginRuntime.findPluginIdByCapability("worker-client");
    const hasWorkerClient = workerClientPluginId
      ? await pluginRuntime.withPluginInstanceLease<KnowledgePluginInstance, boolean>(
          workerClientPluginId,
          async (plugin) => typeof plugin.getWorkerClient === "function",
        )
      : false;
    if (workerClientPluginId && hasWorkerClient) {
      const withWorkerClient = async <T>(
        operation: (client: WorkerSearchClient & KnowledgeWorkerClient) => Promise<T>,
      ): Promise<T> => pluginRuntime.withPluginInstanceLease<KnowledgePluginInstance, T>(
        workerClientPluginId,
        async (plugin) => {
          const client = plugin.getWorkerClient?.();
          if (!client) {
            throw new Error(`plugin '${workerClientPluginId}' no longer exposes getWorkerClient()`);
          }
          return operation(client);
        },
      );
      const workerSearchClient: WorkerSearchClient = {
        searchBm25: (query, topK) => withWorkerClient((client) => client.searchBm25(query, topK)),
        searchVector: (query, topK) => withWorkerClient((client) => client.searchVector(query, topK)),
      };
      const knowledgeWorkerClient: KnowledgeWorkerClient = {
        listDocuments: () => withWorkerClient((client) => client.listDocuments()),
        getStructure: (docId) => withWorkerClient((client) => client.getStructure(docId)),
        getPageContent: (docId, pages) => withWorkerClient((client) => client.getPageContent(docId, pages)),
      };
      const cloudAdapter = new MockCloudIndexAdapter();
      const hybridRetriever = new HybridRetriever({
        workerClient: workerSearchClient,
        cloudAdapter,
      });
      const knowledgeTools = createKnowledgeSearchTools({
        hybridRetriever,
        workerClient: knowledgeWorkerClient,
      });
      for (const tool of knowledgeTools) {
        toolRegistry.register(tool);
      }
      knowledgeAvailable = true;
      log.info("boot: knowledge tools registered (%d tools)", knowledgeTools.length);

      // §6.1 IdleScheduler: idle/throttle state machine for the shared idle
      // consumers (preference-refresh, post-turn signalling, conversation-loop).
      // Indexing no longer defers through this scheduler — the local-indexer
      // plugin's FolderAutoIndexer indexes eagerly in its background worker
      // process — so the scheduler is constructed without an index worker
      // client and only drives idle-state notifications.

      try {
        const { powerMonitor } = await import("electron");
        idleScheduler = new IdleSchedulerService({
          powerMonitor: adaptPowerMonitor(powerMonitor),
        });
        idleScheduler.start();
      } catch (err) {
        log.warn(
          "boot: idle-scheduler setup failed (non-fatal): %s",
          (err as Error).message,
        );
      }
    } else {
      log.warn(
        "boot: worker-client capability missing getWorkerClient() — knowledge tools skipped",
      );
      auditService.log({
        timestamp: new Date().toISOString(),
        sessionId: "boot",
        type: "error",
        payload: {
          reason: "knowledge tools skipped — getWorkerClient missing",
          pluginId: workerClientPluginId ?? "(capability:worker-client not found)",
        },
      });
    }
  } catch (err) {
    log.warn("boot: knowledge tools DI failed (non-fatal): %s", (err as Error).message);
    auditService.log({
      timestamp: new Date().toISOString(),
      sessionId: "boot",
      type: "error",
      payload: {
        reason: "knowledge tools DI failed",
        error: (err as Error).message,
      },
    });
  }
  return { idleScheduler, knowledgeAvailable };
}

export interface WorkflowToolDeps {
  /** Lazy-resolved gate — populated after BrowserWindow is ready. */
  getAskUserQuestionGate?: () => AskUserQuestionGate | undefined;
  routinesStore?: RoutinesStore;
  sessionTodoStore?: SessionTodoStore;
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
  /** C2(d): ApprovalGate for first-use skill approval modal. */
  getApprovalGate?: () => ApprovalGate | undefined;
  /** Electron network-stack fetch used when host-resolver-rules are active. */
  networkFetch?: typeof fetch;
  emitAgentSpawn?: (event: AgentSpawnEvent) => void;
  emitSkillLoad?: (event: SkillLoadEvent) => void;
  acquirePluginSkillGeneration?: NonNullable<SkillLoadToolDeps["acquirePluginGeneration"]>;
}

export function registerBuiltinTools(
  toolRegistry: ToolRegistry,
  settingsService: SettingsService,
  workflowDeps?: WorkflowToolDeps,
): void {
  const networkFetch = workflowDeps?.networkFetch ?? fetch;
  const builtins: Tool[] = [
    createWebSearchTool(settingsService, networkFetch),
    createWebFetchTool(networkFetch),
    createRenderHtmlTool(),
  ];

  // Workflow system tools (S1+S2). Each is gated on its dependency being
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
  if (workflowDeps?.sessionTodoStore) {
    builtins.push(createTodoSessionWriteTool(workflowDeps.sessionTodoStore));
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
    );
  }
  if (workflowDeps?.agentProfileStore) {
    builtins.push(createAgentListTool(workflowDeps.agentProfileStore));
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
    workflowDeps.getApprovalGate
  ) {
    builtins.push(
      createSkillLoadTool({
        store: workflowDeps.skillStore,
        overlay: workflowDeps.skillOverlay,
        approvals: workflowDeps.skillApprovalsStore,
        getApprovalGate: workflowDeps.getApprovalGate,
        emit: workflowDeps.emitSkillLoad,
        acquirePluginGeneration: workflowDeps.acquirePluginSkillGeneration,
      }),
    );
    builtins.push(createSkillListTool(workflowDeps.skillStore));
  }

  toolRegistry.registerBatch(builtins);
}
