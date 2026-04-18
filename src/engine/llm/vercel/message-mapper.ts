/**
 * GenericMessage ↔ Vercel AI SDK ModelMessage mapper.
 *
 * P1 — Gemini-safe path:
 *   - user → { role: "user", content: [{ type: "text", text }] }
 *   - assistant text → { role: "assistant", content: [{ type: "text", text }] }
 *   - assistant tool call → { role: "assistant", content: [{ type: "tool-call", ... }] }
 *   - tool_result → { role: "tool", content: [{ type: "tool-result", ... }] }
 *
 * P3 — Claude thinkingBlocks round-trip:
 *   - assistant.thinkingBlocks[] → prepended as { type: "reasoning", text,
 *     providerOptions: { anthropic: { signature } } } parts when vendor="claude".
 *     Outbound reasoning parts carry `providerOptions.anthropic.signature`;
 *     inbound stream events arrive via `providerMetadata.anthropic.signature`.
 *     Order matters: reasoning parts must precede text and tool-call parts so
 *     Anthropic's signature-verified thinking chain is echoed verbatim.
 *   - Blocks with missing/empty signatures are skipped (log-and-skip via
 *     signature-shim) — Anthropic rejects tampered echoes.
 *   - [HIGH PRIVACY] thinkingBlocks MUST NOT be serialised when outgoing vendor
 *     is NOT "claude". Pass `vendor` to genericToModelMessages() to enforce this.
 */
import type { ModelMessage } from "ai";
import type { GenericMessage, LLMVendor } from "../types.js";

type AssistantPart =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      text: string;
      providerOptions?: { anthropic?: { signature: string } };
    }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    };

export function genericToModelMessages(
  messages: GenericMessage[],
  vendor: LLMVendor = "claude",
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
      const parts: AssistantPart[] = [];

      // Reasoning FIRST — Anthropic requires thinking blocks to precede text
      // and tool_use in the content array, with signatures verbatim from the
      // prior turn.
      // [HIGH PRIVACY] thinkingBlocks are Claude-specific signed thoughts.
      // They MUST NOT be forwarded to non-Claude vendors (Gemini/OpenAI do not
      // understand them and the signed content must not leave the Claude path).
      if (vendor === "claude" && msg.thinkingBlocks) {
        for (const tb of msg.thinkingBlocks) {
          if (typeof tb.signature !== "string" || tb.signature.length === 0) {
            // Defense-in-depth: thinkingBlocks may be deserialized from persisted
            // history where signatures were trimmed. Guard here ensures we never
            // echo a signature-less block to Anthropic (400).
            // eslint-disable-next-line no-console
            console.warn(
              "[message-mapper] thinkingBlock missing signature — skipping",
            );
            continue;
          }
          parts.push({
            type: "reasoning",
            text: tb.thinking,
            providerOptions: { anthropic: { signature: tb.signature } },
          });
        }
      }

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

      // Omit the message entirely when there is neither visible text nor any
      // tool calls — SDK providers reject empty assistant turns with 400.
      if (parts.length === 0) {
        continue;
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
            output:
              msg.isError === true
                ? { type: "error-text", value: msg.content }
                : { type: "text", value: msg.content },
          },
        ],
      } as ModelMessage);
    }
  }

  return out;
}
