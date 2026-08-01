import type {
  GenericMessage,
  LLMProvider,
  ProviderRequestInputProjection,
  ProviderRequestInputProjectionParams,
  ToolSchema,
} from "./llm/types.js";
import { estimateMessagesTokens, estimateTokens } from "./auto-compact.js";

export interface RequestInputProjection extends ProviderRequestInputProjection {
  /** Full provider request input projection: system prompt + wire messages + exposed tool schemas. */
  totalTokens: number;
  systemPromptTokens: number;
  messageTokens: number;
  toolSchemaTokens: number;
}

export interface RequestInputProjectionInput extends ProviderRequestInputProjectionParams {
  systemPrompt: string;
  messages: GenericMessage[];
  toolSchemas: ToolSchema[];
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidProviderRequestInputProjection(value: unknown): value is RequestInputProjection {
  if (!value || typeof value !== "object") return false;
  const {
    totalTokens,
    systemPromptTokens,
    messageTokens,
    toolSchemaTokens,
  } = value as Partial<ProviderRequestInputProjection>;
  return isNonNegativeSafeInteger(totalTokens)
    && isNonNegativeSafeInteger(systemPromptTokens)
    && isNonNegativeSafeInteger(messageTokens)
    && isNonNegativeSafeInteger(toolSchemaTokens)
    && totalTokens === systemPromptTokens + messageTokens + toolSchemaTokens;
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
  provider?: Pick<LLMProvider, "projectRequestInput">,
): RequestInputProjection {
  try {
    const providerProjection = provider?.projectRequestInput?.(input);
    if (isValidProviderRequestInputProjection(providerProjection)) return providerProjection;
  } catch {
    // Projection is advisory. A provider hook must not widen failures into
    // preflight or compaction control flow.
  }
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
