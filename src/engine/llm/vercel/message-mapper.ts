/**
 * GenericMessage ↔ Vercel AI SDK ModelMessage mapper — P0 stub.
 *
 * TODO(P1): Full round-trip for Anthropic:
 *   - user/assistant text roles
 *   - assistant.thinkingBlocks → reasoning parts with `signature` preserved
 *     (critical: Anthropic rejects turns where signature is dropped during
 *     tool_use in-flight — see types.ts ThinkingBlock doc)
 *   - toolCalls → tool-call parts (id, name, input)
 *   - tool_result → tool-result parts (toolUseId, content, isError)
 *   - system prompt with providerOptions.anthropic.cacheControl
 * TODO(P2): OpenAI reasoning model specifics (reasoning_effort passthrough)
 * TODO(P3): Gemini-specific parts (inlineData, functionCall/Response)
 */
import type { GenericMessage } from "../types.js";

// The `ai` package exports `ModelMessage` — kept loose here to avoid pulling
// the type dependency into the P0 stub surface. P1 will tighten to the real type.
export type ModelMessage = unknown;

export function genericToModelMessages(
  _messages: GenericMessage[],
): ModelMessage[] {
  // TODO(P1): real conversion. See docs/references/vercel-ai-sdk-migration.md §5.2.
  return [];
}
