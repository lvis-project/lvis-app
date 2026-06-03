import { createDynamicTool, type Tool } from "./base.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import { t } from "../i18n/index.js";

export function createAgentListTool(store: AgentProfileStore): Tool {
  return createDynamicTool({
    name: "agent_list",
    description: t("be_agentList.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      const agents = (await store.list()).map((agent) => ({
        name: agent.name,
        description: agent.description,
        sourceTools: agent.sourceTools,
        triggers: agent.triggers,
        model: agent.model,
        mode: agent.mode,
      }));
      return { output: JSON.stringify({ agents }), isError: false };
    },
  });
}
