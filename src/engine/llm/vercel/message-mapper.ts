/**
 * GenericMessage ↔ Vercel AI SDK ModelMessage mapper.
 *
 * P1 — Gemini-safe path:
 *   - user → { role: "user", content: [{ type: "text", text }] }
 *   - assistant text → { role: "assistant", content: [{ type: "text", text }] }
 *   - assistant tool call → { role: "assistant", content: [{ type: "tool-call", ... }] }
 *   - tool_result → { role: "tool", content: [{ type: "tool-result", ... }] }
 *
 * Gemini does not emit thinkingBlocks; they are ignored here. Upstream
 * GenericMessage retains them intact for other vendors.
 *
 * TODO(P2): OpenAI reasoning model specifics (reasoning_effort passthrough).
 * TODO(P3): Claude thinkingBlocks + signature round-trip + cacheControl.
 */
import type { ModelMessage } from "ai";
import type { GenericMessage } from "../types.js";

export function genericToModelMessages(
  messages: GenericMessage[],
): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      out.push({
        role: "user",
        content: [{ type: "text", text: msg.content }],
      });
      continue;
    }

    if (msg.role === "assistant") {
      const parts: Array<
        | { type: "text"; text: string }
        | {
            type: "tool-call";
            toolCallId: string;
            toolName: string;
            input: unknown;
          }
      > = [];

      if (msg.content) {
        parts.push({ type: "text", text: msg.content });
      }

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          parts.push({
            type: "tool-call",
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.input,
          });
        }
      }

      if (parts.length === 0) {
        parts.push({ type: "text", text: "" });
      }

      out.push({
        role: "assistant",
        content: parts,
      } as ModelMessage);
      continue;
    }

    if (msg.role === "tool_result") {
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolUseId,
            toolName: msg.toolName ?? "tool",
            output: { type: "text", value: msg.content },
          },
        ],
      } as ModelMessage);
    }
  }

  return out;
}
