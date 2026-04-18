/**
 * Vercel AI SDK fullStream → LVIS StreamEvent mapper — P0 stub.
 *
 * TODO(P1): Map the following fullStream part types to StreamEvent:
 *   - 'reasoning-delta' → { type: 'reasoning_delta', text }
 *   - 'text-delta'      → { type: 'text_delta', text }
 *   - 'tool-call'       → { type: 'tool_call', id, name, input }
 *   - 'finish'          → { type: 'message_complete', stopReason, usage, thinkingBlocks }
 *   - 'error'           → { type: 'error', error }
 *
 * TODO(P1): Accumulate reasoning parts into `thinkingBlocks` (with signature)
 *           so the next turn can echo them back per Anthropic's requirement.
 * TODO(P2): Handle OpenAI /v1/responses stream quirks (reasoning before tool).
 * TODO(P3): Gemini-specific finishReason normalisation.
 */
import type { StreamEvent } from "../types.js";

export async function* fullStreamToStreamEvent(
  _stream: AsyncIterable<unknown>,
): AsyncIterable<StreamEvent> {
  // TODO(P1): real mapping.
  return;
}
