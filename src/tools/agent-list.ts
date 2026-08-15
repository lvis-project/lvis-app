import { createDynamicTool, type Tool } from "./base.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import { isResumableSubAgentTaskState } from "../engine/subagent-runner.js";
import { t } from "../i18n/index.js";

export interface AgentListToolDeps {
  store: AgentProfileStore;
  /** Same accessor agent_spawn uses; absent on surfaces without a runner. */
  getRunner?: () => SubAgentRunner | undefined;
}

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
        // Resumability comes from the runner's own resume-gate predicates:
        // only INPUT_REQUIRED is accepted there, so only INPUT_REQUIRED may
        // be advertised here. SUBMITTED/WORKING/unrecorded children were
        // interrupted mid-run — the model still benefits from seeing they
        // existed (start fresh if that work is needed again), but a resume
        // attempt on them is a guaranteed permanent rejection.
        //
        // The resume-axis counters are the second half of that same gate: a
        // child that spent its resume budget stays INPUT_REQUIRED forever, so
        // reading the state alone would advertise a resume that is likewise a
        // guaranteed permanent rejection — one wasted parent round each time.
        resumable: isResumableSubAgentTaskState(entry.taskState)
          && !runner?.isResumeExhausted(entry.childSessionId),
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
