/**
 * Boot step — workflow system stores, workflow tool deps, and builtin tool
 * registration (§4.2 Step 4 + §4.4, extracted from boot.ts C18).
 *
 * Constructs the workflow-tool-backing stores (session todos, skills, agent
 * profiles, persona prompts, skill overlay/approvals, ask-user gate), assembles
 * the {@link WorkflowToolDeps} closure bundle (late-binding the sub-agent runner
 * and approval gate through refs), registers the builtin + meta tools, and wires
 * the knowledge retriever + idle scheduler.
 */
import { SessionTodoStore } from "../../main/session-todo-store.js";
import { AskUserQuestionGate } from "../../main/ask-user-question-gate.js";
import { SkillStore } from "../../main/skill-store.js";
import { SkillOverlay } from "../../main/skill-overlay.js";
import { SkillApprovalsStore } from "../../main/skill-approvals-store.js";
import { AgentProfileStore } from "../../main/agent-profile-store.js";
import { PersonaPromptStore } from "../../main/persona-prompt-store.js";
import type { SubAgentRunner } from "../../engine/subagent-runner.js";
import type { AgentSpawnEvent } from "../../shared/subagent-events.js";
import type { SkillLoadEvent } from "../../tools/skill-load.js";
import {
  registerBuiltinTools,
  registerRequestPluginMetaTool,
  registerToolSearchMetaTool,
  wireKnowledgeAndIdleScheduler,
  type WorkflowToolDeps,
} from "../tools.js";
import { createLogger } from "../../lib/logger.js";
import type { BootContext } from "../context.js";

const log = createLogger("lvis");

export async function setupWorkflowStores(ctx: BootContext): Promise<void> {
  const {
    routinesStore,
    getMainWindow,
    notificationService,
    approvalGate,
    networkFetch,
    privateNetworkFetch,
    demoActiveVendor,
    demoHostMap,
    isAppliedDemoHostMap,
    toolRegistry,
    settingsService,
    pluginRuntime,
    auditService,
  } = ctx;

  const sessionTodoStore = new SessionTodoStore();
  const skillStore = new SkillStore();
  const agentProfileStore = new AgentProfileStore();
  const personaPromptStore = new PersonaPromptStore();
  const skillOverlay = new SkillOverlay();
  const skillApprovalsStore = new SkillApprovalsStore();
  await skillApprovalsStore.load().catch((err) => {
    log.warn(
      "boot: skill-approvals load failed (non-fatal): %s",
      (err as Error).message,
    );
  });
  const askUserQuestionGate = new AskUserQuestionGate(
    // Lazy resolver — dev-mode reloads destroy the captured webContents.
    // Looking it up on every send keeps the gate working across reloads
    // and across window recreation.
    () => getMainWindow()?.webContents ?? null,
    undefined,
    notificationService,
  );
  const subAgentRunnerRef: { fn: SubAgentRunner | undefined } = { fn: undefined };
  // ApprovalGate ref — gate is constructed up-front (before initPluginRuntime)
  // so this is bound immediately. skill_load reuses the same gate the
  // executor uses so user-authored skills pop the approval modal on first
  // load (and only on first load).
  const approvalGateRef: { fn: import("../../permissions/approval-gate.js").ApprovalGate | undefined } = { fn: approvalGate };
  const workflowDeps: WorkflowToolDeps = {
    routinesStore,
    sessionTodoStore,
    skillStore,
    agentProfileStore,
    skillOverlay,
    skillApprovalsStore,
    getAskUserQuestionGate: () => askUserQuestionGate,
    getApprovalGate: () => approvalGateRef.fn,
    getSubAgentRunner: () => subAgentRunnerRef.fn,
    emitAgentSpawn: (event: AgentSpawnEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:agent-spawn:event", event);
      } catch (err) {
        log.warn("agent_spawn emit failed: %s", (err as Error).message);
      }
    },
    emitSkillLoad: (event: SkillLoadEvent) => {
      try {
        getMainWindow()?.webContents.send("lvis:skill-load:event", event);
      } catch (err) {
        log.warn("skill_load emit failed: %s", (err as Error).message);
      }
    },
    networkFetch,
    privateNetworkFetch,
    demoActiveVendor,
    demoHostMap,
    demoHostMapApplied: isAppliedDemoHostMap,
  };

  // §4.2 Step 4: builtin tools + request_plugin / tool_search meta tools.
  registerBuiltinTools(toolRegistry, settingsService, workflowDeps);
  registerRequestPluginMetaTool(toolRegistry);
  // Statically registered; visible whenever builtins are in scope because
  // tool-level deferral is the only plugin/MCP schema exposure path.
  registerToolSearchMetaTool(toolRegistry);

  // §4.4 HybridRetriever + Knowledge Tools DI, §6.1 IdleSchedulerService.
  const { idleScheduler, knowledgeAvailable } = await wireKnowledgeAndIdleScheduler({
    pluginRuntime,
    toolRegistry,
    auditService,
  });

  ctx.sessionTodoStore = sessionTodoStore;
  ctx.skillStore = skillStore;
  ctx.agentProfileStore = agentProfileStore;
  ctx.personaPromptStore = personaPromptStore;
  ctx.skillOverlay = skillOverlay;
  ctx.skillApprovalsStore = skillApprovalsStore;
  ctx.askUserQuestionGate = askUserQuestionGate;
  ctx.subAgentRunnerRef = subAgentRunnerRef;
  ctx.idleScheduler = idleScheduler;
  ctx.knowledgeAvailable = knowledgeAvailable;
}
