export type MarketplacePackageType = "plugin" | "mcp" | "agent" | "skill";

export interface AssistantAgentSummary {
  name: string;
  description: string;
  sourceTools: string[];
  triggers: string[];
  model?: string;
  mode?: string;
}

export interface AssistantSkillSummary {
  name: string;
  description: string;
  triggers: string[];
}

export interface SelectedAssistantContext {
  agentName?: string;
  skillNames?: string[];
}
