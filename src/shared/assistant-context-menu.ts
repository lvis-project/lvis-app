export interface AssistantContextMenuOption {
  name: string;
}

export interface AssistantContextMenuPersona {
  id: string;
  name: string;
}

export interface AssistantContextMenuPayload {
  requestId: string;
  x: number;
  y: number;
  agents: AssistantContextMenuOption[];
  skills: AssistantContextMenuOption[];
  personas: AssistantContextMenuPersona[];
  activeAgentName: string;
  activeSkillNames: string[];
  activePersonaId: string;
}

export type AssistantContextMenuAction =
  | { requestId: string; kind: "agent"; name: string }
  | { requestId: string; kind: "skill-toggle"; name: string }
  | { requestId: string; kind: "skills-clear" }
  | { requestId: string; kind: "persona"; id: string };
