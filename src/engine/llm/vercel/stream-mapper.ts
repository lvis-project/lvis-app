/**
 * Vercel AI SDK fullStream → LVIS StreamEvent mapper.
 *
 * P1 — Gemini path:
 *   - 'text-delta'      → { type: 'text_delta', text }
 *   - 'reasoning-delta' → { type: 'reasoning_delta', text } (Gemini doesn't emit)
 *   - 'tool-call'       → { type: 'tool_call', id, name, input }
 *   - 'finish'          → { type: 'message_complete', stopReason, usage }
 *   - 'error'           → { type: 'error', error }
 *
 * TODO(P2): OpenAI /v1/responses stream quirks.
 * TODO(P3): Claude thinkingBlocks signature accumulation.
 */
import type { StreamEvent } from "../types.js";

type AnyPart = Record<string, unknown> & { type: string };

export async function* fullStreamToStreamEvent(
  stream: AsyncIterable<AnyPart>,
): AsyncIterable<StreamEvent> {
  let hasToolCalls = false;

  for await (const part of stream) {
    switch (part.type) {
      case "text-delta": {
        const text = (part as { text?: string }).text ?? "";
        if (text) yield { type: "text_delta", text };
        break;
      }
      case "reasoning-delta": {
        const text = (part as { text?: string }).text ?? "";
        if (text) yield { type: "reasoning_delta", text };
        break;
      }
      case "tool-call": {
        const p = part as unknown as {
          toolCallId: string;
          toolName: string;
          input: unknown;
        };
        hasToolCalls = true;
        yield {
          type: "tool_call",
          id: p.toolCallId,
          name: p.toolName,
          input: (p.input ?? {}) as Record<string, unknown>,
        };
        break;
      }
      case "finish": {
        const p = part as {
          finishReason?: string;
          totalUsage?: {
            inputTokens?: number;
            outputTokens?: number;
          };
        };
        const stopReason: "tool_use" | "end_turn" =
          p.finishReason === "tool-calls" || hasToolCalls
            ? "tool_use"
            : "end_turn";
        yield {
          type: "message_complete",
          stopReason,
          usage: p.totalUsage
            ? {
                inputTokens: p.totalUsage.inputTokens ?? 0,
                outputTokens: p.totalUsage.outputTokens ?? 0,
              }
            : undefined,
        };
        break;
      }
      case "error": {
        const err = (part as { error?: unknown }).error;
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : JSON.stringify(err);
        yield { type: "error", error: msg };
        break;
      }
      default:
        // Ignore non-essential parts (start, start-step, finish-step,
        // text-start/end, reasoning-start/end, tool-input-*, raw, etc.)
        break;
    }
  }
}
