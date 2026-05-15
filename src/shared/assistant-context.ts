export type MarketplacePackageType = "plugin" | "mcp" | "agent" | "skill";

export interface AssistantAgentSummary {
  name: string;
  description: string;
  sourceTools: string[];
  triggers: string[];
  model?: string;
  mode?: string;
  source: "user";
}

export interface AssistantSkillSummary {
  name: string;
  description: string;
  triggers: string[];
  source: "user" | "builtin";
}

export interface SelectedAssistantContext {
  agentName?: string;
  skillNames?: string[];
}
