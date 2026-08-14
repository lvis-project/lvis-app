import { createDynamicTool, type Tool } from "./base.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import { A2ATaskState } from "../shared/a2a.js";
import { t } from "../i18n/index.js";

export interface AgentListToolDeps {
  store: AgentProfileStore;
  /** Same accessor agent_spawn uses; absent on surfaces without a runner. */
  getRunner?: () => SubAgentRunner | undefined;
}

/** Sub-agent states a parent can act on by resuming. */
const RESUMABLE_TASK_STATES = new Set<string>([
  A2ATaskState.INPUT_REQUIRED,
  A2ATaskState.SUBMITTED,
  A2ATaskState.WORKING,
]);

export function createAgentListTool(deps: AgentListToolDeps): Tool {
  return createDynamicTool({
    name: "agent_list",
    description: t("be_agentList.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async (_rawInput, ctx) => {
      const agents = (await deps.store.list()).map((agent) => ({
        name: agent.name,
        description: agent.description,
        sourceTools: agent.sourceTools,
        triggers: agent.triggers,
        model: agent.model,
        mode: agent.mode,
      }));

      // THIS conversation's existing sub-agents, alongside the profile
      // definitions. Observed failure without it: told to "continue the
      // agents", the model called agent_list looking for them, got only
      // profile definitions back, and spawned FRESH agents — discarding the
      // suspended children's context. The list is the natural place to answer
      // the question the model was actually asking.
      const originSessionId = typeof ctx.metadata?.sessionId === "string"
        ? ctx.metadata.sessionId
        : "";
      const runner = deps.getRunner?.();
      const persisted = originSessionId && runner
        ? runner.listPersistedSpawnsForOrigin(originSessionId)
        : [];
      const existingSubAgents = persisted.map((entry) => ({
        title: entry.title,
        resumeId: entry.childSessionId,
        taskState: entry.taskState ?? "unrecorded",
        // Unrecorded means the child died before writing a projection — at
        // least as unfinished as WORKING, so it stays resumable.
        resumable: entry.taskState === undefined
          || RESUMABLE_TASK_STATES.has(entry.taskState),
      }));

      return {
        output: JSON.stringify({
          agents,
          ...(existingSubAgents.length > 0
            ? {
                existingSubAgents,
                existingSubAgentsGuidance: t("be_agentList.existingGuidance"),
              }
            : {}),
        }),
        isError: false,
      };
    },
  });
}
