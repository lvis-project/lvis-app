export interface AssistantContextMenuPersona {
  id: string;
  name: string;
}

export interface AssistantContextMenuPayload {
  requestId: string;
  x: number;
  y: number;
  personas: AssistantContextMenuPersona[];
  activePersonaId: string;
}

export type AssistantContextMenuAction =
  { requestId: string; kind: "persona"; id: string };
