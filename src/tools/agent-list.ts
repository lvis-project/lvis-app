import { createDynamicTool, type Tool } from "./base.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";

export function createAgentListTool(store: AgentProfileStore): Tool {
  return createDynamicTool({
    name: "agent_list",
    description:
      "현재 사용할 수 있는 LVIS agent profiles 목록을 반환합니다. agent_spawn 의 agentName 선택 전에 사용하세요.",
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
        source: agent.source,
      }));
      return { output: JSON.stringify({ agents }), isError: false };
    },
  });
}
