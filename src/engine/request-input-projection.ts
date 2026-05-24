import type { GenericMessage, ToolSchema } from "./llm/types.js";
import { estimateMessagesTokens, estimateTokens } from "./auto-compact.js";

export interface RequestInputProjection {
  /** Full provider request input projection: system prompt + wire messages + exposed tool schemas. */
  totalTokens: number;
  systemPromptTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
}

export interface RequestInputProjectionInput {
  systemPrompt: string;
  messages: GenericMessage[];
  toolSchemas: ToolSchema[];
}

/**
 * Engine-side input projection SOT.
 *
 * Renderer cannot know the final system prompt, active tool schemas, or
 * provider-wire tool_result stubbing. ConversationLoop must therefore compute
 * context pressure from the same request parts sent to the provider.
 */
export function estimateRequestInputProjection(
  input: RequestInputProjectionInput,
): RequestInputProjection {
  const systemPromptTokens = input.systemPrompt.trim().length > 0
    ? estimateTokens(JSON.stringify({ role: "system", content: input.systemPrompt }))
    : 0;
  const messageTokens = estimateMessagesTokens(input.messages);
  const toolSchemaTokens = input.toolSchemas.length > 0
    ? estimateTokens(JSON.stringify({ tools: input.toolSchemas }))
    : 0;
  return {
    totalTokens: systemPromptTokens + messageTokens + toolSchemaTokens,
    systemPromptTokens,
    messageTokens,
    toolSchemaTokens,
  };
}

export function projectNextTurnInputTokens(params: {
  providerInputTokens: number;
  lastRoundProjection: RequestInputProjection;
  postTurnProjection: RequestInputProjection;
}): number {
  if (params.providerInputTokens <= 0) return params.postTurnProjection.totalTokens;
  const projectedDelta =
    params.postTurnProjection.totalTokens - params.lastRoundProjection.totalTokens;
  return Math.max(0, params.providerInputTokens + projectedDelta);
}
