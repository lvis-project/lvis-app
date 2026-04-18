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
            promptTokens?: number;
            completionTokens?: number;
          };
          usage?: {
            inputTokens?: number;
            outputTokens?: number;
            promptTokens?: number;
            completionTokens?: number;
          };
        };
        // Honor finishReason explicitly when present; fallback to sticky
        // hasToolCalls only when finishReason is missing.
        let stopReason: "tool_use" | "end_turn";
        if (p.finishReason === "tool-calls") {
          stopReason = "tool_use";
        } else if (p.finishReason) {
          stopReason = "end_turn";
        } else {
          stopReason = hasToolCalls ? "tool_use" : "end_turn";
        }
        // v5 exposes totalUsage; v4 exposed usage. Accept either and tolerate
        // both inputTokens/outputTokens (v5) and promptTokens/completionTokens (v4).
        const usageRaw = p.totalUsage ?? p.usage;
        const usage = usageRaw
          ? {
              inputTokens:
                usageRaw.inputTokens ?? usageRaw.promptTokens ?? 0,
              outputTokens:
                usageRaw.outputTokens ?? usageRaw.completionTokens ?? 0,
            }
          : undefined;
        yield {
          type: "message_complete",
          stopReason,
          usage,
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
